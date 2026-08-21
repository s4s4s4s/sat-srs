import { State } from 'ts-fsrs'
import type { CardRec, CardView, JournalRec, JournalLine, ReadingRec } from './types'
import { cardView, readingView } from './yamlfm'
import { addDaysKey, dayKey, isoLocal } from './daytime'
import {
  minutesByDay, readMinutesByDay, streak, trueRetention30, retentionByFormat, READ_MIN_MINUTES,
  markDigest, markCount, readingSrc, readingPassed, readTextSlugs, normWord,
  READING_UNKNOWN_SHARE_MAX, type PauseRange
} from './journal'
import { activeLevel, levelStats, isLevelled, EXAM_DATE, SECTIONS } from './scheduler'
import {
  examReady, maturity, pace, retentionByInterval, retentionBySection, maturityBySection,
  speedStats, typoSplit, gaveUpShare, planVsFact, isLeechCard, orphanedLines, ddmm,
  PRIMARY_DATE, NEW_STOP_DATE, TARGET_REVIEW, TARGET_MATURE, MATURE_STABILITY_DAYS,
  INTERVAL_LABELS, SECTION_LABELS, type IntervalBucket
} from './metrics'

/**
 * Автогенерируемый отчёт для ИИ-тьютора: `_отчёт.md` рядом с карточками.
 * Перезаписывается при каждой синхронизации. Только чтение для тьютора:
 * сводка, план vs факт, прогноз нагрузки, проблемные слова, полная таблица.
 */

const STATE_RU: Record<number, string> = { 0: 'new', 1: 'learning', 2: 'review', 3: 'relearning' }

const fmtDay = (d: Date) => dayKey(d)

function pct(part: number, total: number): string {
  return total ? `${Math.round((part / total) * 100)}% (n=${total})` : '—'
}

/**
 * Значение в ячейку markdown-таблицы.
 *
 * В ячейку попадает предложение из журнала — чужой текст, про который ничего не
 * обещано. Перевод строки закрывает таблицу на середине, вертикальная черта режет
 * строку на лишние столбцы: и то и другое ломает весь отчёт молча, а не в этой ячейке.
 */
const cell = (s: string, max = 120): string => {
  const one = s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

/** Сколько кандидатов в карточки печатать таблицей: дальше это уже не список, а свалка. */
const CANDIDATE_CAP = 60

export function buildReport(cards: CardRec[], journal: JournalRec[], readings: ReadingRec[], now: Date = new Date(), pause?: PauseRange | null): string {
  const today = dayKey(now)
  const views = cards.filter(c => !c.broken).map(cardView)
  const active = views.filter(v => !v.suspended)
  const brokenCount = cards.filter(c => c.broken).length
  const lines: JournalLine[] = journal

  const byState = { new: 0, learning: 0, review: 0 }
  for (const v of active) {
    if (v.fsrs.state === State.New) byState.new++
    else if (v.fsrs.state === State.Review) byState.review++
    else byState.learning++
  }
  const prepCount = active.filter(v => v.prep).length

  const st = streak(lines, today, pause)
  const minutes = minutesByDay(lines)
  const ret = trueRetention30(lines, today)
  const retF = retentionByFormat(lines, today)
  const sp = speedStats(lines)
  const ts = typoSplit(lines)
  const gu = gaveUpShare(lines)   // за всю историю; дневной срез уже копится в _метрики.ndjson

  // прогноз нагрузки: due по учебным дням на 7 дней вперёд (просроченное — в «сегодня»)
  const load = new Map<string, number>()
  for (const v of active) {
    const items = [v.fsrs, ...(v.fsrsPrep && v.fsrsPrep.state !== State.New ? [v.fsrsPrep] : [])]
    for (const f of items) {
      if (f.state === State.New) continue
      let d = fmtDay(f.due)
      if (d < today) d = today
      if (d <= addDaysKey(today, 6)) load.set(d, (load.get(d) ?? 0) + 1)
    }
  }

  const pvf = planVsFact(lines, today)

  /* Проблемные слова ищутся по РАБОТЕ, а не по провалам.
     Порог `lapses >= 3` не сработал ни разу за всю историю, и не мог: `lapses`
     растёт только при провале карточки, УЖЕ находящейся в Review, а до Review
     в этой колоде не дошёл почти никто — максимум lapses в живой колоде равен
     двум. При этом настоящие пиявки были и жрали урок: bolster — 24 показа при
     стабильности 0,21 дня; scrutinize — 20 при 1,5; corroborate — 19 при 2,7.
     Три слова съели 63 показа из 472, то есть 13% всей работы системы, и ни
     одно не попало в список.
     Признак пиявки — много повторов при неподросшей стабильности. Повторение
     интерференцию не лечит: такое слово надо переформулировать (новый контекст,
     другая мнемоника, confusables), а не показывать ещё раз. */
  const затраты = (v: CardView) => v.fsrs.reps + (v.fsrsPrep?.reps ?? 0)
  const leeches = active
    .filter(isLeechCard)
    .sort((a, b) => затраты(b) - затраты(a))
  const errFrom = addDaysKey(today, -13)
  const errByFormat = new Map<string, Map<string, number>>()
  for (const l of lines) {
    if (l.type !== 'review' || l.correct !== false || !l.day || l.day < errFrom || !l.slug) continue
    const f = l.format ?? '?'
    if (!errByFormat.has(f)) errByFormat.set(f, new Map())
    const m = errByFormat.get(f)!
    m.set(l.slug, (m.get(l.slug) ?? 0) + 1)
  }
  const errList = (f: string) => {
    const m = errByFormat.get(f)
    if (!m || !m.size) return '—'
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => (n > 1 ? `${s} ×${n}` : s)).join(', ')
  }

  const week = Array.from({ length: 7 }, (_, i) => addDaysKey(today, -6 + i))
  const min7 = week.reduce((a, d) => a + (minutes.get(d) ?? 0), 0)
  // Чтение — вторая половина защищённого минимума и половина работы над SAT, но в отчёт
  // не попадало ни разу, и «0/7 (не трекается)» семь недель никто не видел глазами.
  const readMin = readMinutesByDay(lines)
  const read7 = week.reduce((a, d) => a + (readMin.get(d) ?? 0), 0)

  const out: string[] = []
  out.push('---', 'type: report', 'report_schema: 1', `updated: "${isoLocal(now)}"`, '---', '')
  out.push('# SRS-отчёт (автогенерация)', '')
  out.push('> Файл пишет приложение SAT SRS при каждой синхронизации — не редактировать. Источник сырых данных: `_журнал/*.ndjson` (каждая оценка: ts, слово, навык, формат, correct, rating, план следующего показа) и frontmatter карточек.', '')

  /* Цель сменилась 17.08.2026. Было «400 готовых слов к 03.10» по прогнозной
     retrievability — снято как арифметически недостижимое (слово созревает за 21 день
     стабильности, значит введённое после ~12.09 к первой попытке не успевает).
     Стало: довести 250–300 карточек до review и сделать 150+ из них зрелыми.
     Готовность по retrievability осталась справочной строкой — тьютору она полезна,
     но планом больше не является и ни с какой целевой цифрой не сравнивается. */
  const erP = examReady(active, PRIMARY_DATE)
  const erE = examReady(active, EXAM_DATE)
  const pc = pace(active, lines, NEW_STOP_DATE, now)
  const mat = maturity(active)
  const verdictStr = pc.verdict === 'ahead'
    ? 'идёшь с опережением'
    : pc.daysBehind === null ? 'темпа нет — 0 слов за 14 дн' : `отстаёшь на ${pc.daysBehind} дн`
  out.push('## Прогресс к экзамену', '')
  out.push(`> Цель (с 17.08.2026): довести **${TARGET_REVIEW}** карточек до состояния review — коридор 250–300 — и сделать **${TARGET_MATURE}+** из них зрелыми (стабильность ≥ ${MATURE_STABILITY_DAYS} дн) к ${ddmm(PRIMARY_DATE)}. Ввод новых слов прекращается ${ddmm(NEW_STOP_DATE)} (последний рабочий день ввода — накануне), дальше только дозревание введённого.`, '')
  out.push(`- В review: **${mat.reviewCount} из ${TARGET_REVIEW}** · зрелых (стаб.≥${MATURE_STABILITY_DAYS}дн): **${mat.matureCount} из ${TARGET_MATURE}** · медианная стабильность ${mat.medianStability} дн`)
  out.push(pc.verdict === 'closed'
    ? `- Ввод новых закрыт с ${ddmm(NEW_STOP_DATE)}: добор объёма окончен, темп ввода больше не считается`
    : `- Ввод новых закрывается ${ddmm(NEW_STOP_DATE)}: довести ещё **${pc.remaining}** · нужно **+${pc.neededPerDay}/день** (осталось ${pc.daysLeft} дн ввода) · **${verdictStr}**`)
  out.push(`- Темп: +${pc.actual7} за 7 дн · +${pc.actual14} за 14 дн (выход в review по журналу)`)
  out.push(`- Справочно, готовность по прогнозной retrievability (R ≥ 0.90, без будущих повторов): к ${ddmm(PRIMARY_DATE)} ${erP.ready} · к ${ddmm(EXAM_DATE)} ${erE.ready} · всего словарных карточек ${erP.total}`)
  const byLv = erP.byLevel.filter(l => l.level < 999)
  if (byLv.length) out.push(`- Готовность по ступеням: ${byLv.map(l => `L${l.level} ${l.ready}/${l.total}`).join(' · ')}`)
  const ri = retentionByInterval(lines)
  const riParts = (Object.keys(ri) as IntervalBucket[]).map(k => `${INTERVAL_LABELS[k]} ${ri[k].pct === null ? '—' : ri[k].pct + '%'}${ri[k].n ? ` (n=${ri[k].n})` : ''}`)
  out.push(`- Retention по бакетам интервала: ${riParts.join(' · ')}`)
  // Разрез по разделам (слова/грамматика/математика) — до 17.08.2026 отсутствовал везде:
  // ни retention, ни зрелость не показывали, какой раздел проседает.
  const rs = retentionBySection(views, lines)
  const rsParts = SECTIONS.map(s => {
    const b = rs.get(s) ?? { pct: null as number | null, n: 0, pass: 0 }
    return `${SECTION_LABELS[s]} ${b.pct === null ? '—' : b.pct + '%'}${b.n ? ` (n=${b.n})` : ''}`
  })
  out.push(`- Retention по разделам: ${rsParts.join(' · ')}`)
  // Join по slug (retentionByLevel/Domain/Section выше) молча теряет строку, если карточки
  // со slug уже нет в колоде (переработка пиявки, переименование файла) — тьютору нужно
  // видеть это явно, а не догадываться по тихо просевшим процентам.
  const orph = orphanedLines(views, lines)
  out.push(orph.n
    ? `- Осиротевшие строки журнала (slug карточки пропал из колоды — переработка/переименование): **${orph.n} из ${orph.total} (${Math.round(orph.share * 100)}%)** · ${orph.slugs.map(s => `${s.slug} ×${s.n}`).join(', ')}`
    : `- Осиротевшие строки журнала: нет — все ${orph.total} строк со slug привязаны к карточкам колоды`)
  const ms = maturityBySection(active)
  const msParts = SECTIONS.map(s => `${SECTION_LABELS[s]} review ${ms[s].reviewCount}/${ms[s].total} · зрелых ${ms[s].matureCount}/${ms[s].total}`)
  out.push(`- В review / зрелых по разделам: ${msParts.join(' · ')}`)
  out.push('')

  out.push('## Сводка', '')
  out.push(`- Слов: **${active.length}** (new ${byState.new} · learning ${byState.learning} · review ${byState.review}) · prep-навыков: ${prepCount}${brokenCount ? ` · битых файлов: ⚠️ ${brokenCount}` : ''}`)
  const actLv = activeLevel(active)
  const lvStats = levelStats(active)
  const curLv = lvStats.find(s => s.level === actLv)
  if (curLv) out.push(`- Активный уровень: **${actLv}** (введено ${curLv.introduced}/${curLv.total} · в review ${curLv.review}) · всего уровней: ${lvStats.length}`)
  out.push(`- Серия: **${st.days} дн** (${st.todayDone ? 'сегодня зачтён' : 'сегодня НЕ зачтён'}) · минут сегодня: ${Math.round(minutes.get(today) ?? 0)} · за 7 дн: ${Math.round(min7)}`)
  out.push(`- Чтение (вторая половина минимума, норма ${READ_MIN_MINUTES} мин/день): минут сегодня: ${Math.round(readMin.get(today) ?? 0)} · **за 7 дн: ${Math.round(read7)}** из ${READ_MIN_MINUTES * 7}`)
  out.push(`- True retention 30 дн (review-показы): **${ret.pct === null ? '—' : ret.pct + '%'}**${ret.n ? ` (n=${ret.n})` : ''}`)
  const fmtNames: Record<string, string> = { mc: 'MC', type: 'ввод', prep: 'предлоги', reveal: 'показ' }
  const retParts = Object.entries(retF).map(([f, v]) => `${fmtNames[f] ?? f} ${pct(v.pass, v.total)}`)
  if (retParts.length) out.push(`- По форматам: ${retParts.join(' · ')}`)
  /* Три метрики ниже (скорость по видам, «не помню», опечатки vs незнание) считались
     в metrics.ts и раньше, но не попадали ни на экран, ни в отчёт — тьютор их не видел
     нигде. «Не помню» — прямой признак того, что ученик перестал пытаться вспомнить. */
  const kindNames: Record<string, string> = { vocab: 'слово', grammar: 'грамматика', math: 'математика', error: 'разбор ошибки' }
  const kindParts = Object.entries(sp.byKind).map(([k, v]) => `${kindNames[k] ?? k} ${(v.medianMs / 1000).toFixed(1)} c (n=${v.n})`)
  if (kindParts.length) out.push(`- Скорость ответа по видам карточек (медиана): ${kindParts.join(' · ')}`)
  out.push(`- «Не помню» вместо попытки вспомнить (вся история, интро не считается): ${pct(gu.gaveUp, gu.n)}`)
  const typoTotal = ts.typos + ts.realMisses
  out.push(`- Ошибки ввода слова: опечаток ${ts.typos} · настоящих незнаний ${ts.realMisses}${typoTotal ? ` (доля опечаток ${Math.round((ts.typos / typoTotal) * 100)}%, n=${typoTotal})` : ''}`)
  out.push('')

  /* Чтение и отметки незнакомых слов появились в приложении 22.08.2026, а в отчёте
     их не было: тьютор видел одну строку про минуты чтения и ни одного слова, о
     которое владелец споткнулся. Отметка существует ради того, чтобы слово стало
     карточкой; отметка, которой никто не читает, карточкой не станет никогда и
     остаётся строкой в ndjson. */
  const deckWords = new Set(views.map(v => normWord(v.word)))
  const md = markDigest(lines, deckWords)
  const readSlugs = readTextSlugs(lines)
  const texts = readings
    .map(readingView)
    .filter(t => !t.broken)
    .sort((a, b) => a.level - b.level || a.order - b.order || a.slug.localeCompare(b.slug))

  out.push('## Чтение текстов', '')
  if (!texts.length) {
    out.push('- Текстов нет: каталог `Учёба/Чтение` пуст или ещё не синхронизирован.', '')
  } else {
    out.push(`> Порог понятности: отмеченных незнакомыми слов не больше ${Math.round(READING_UNKNOWN_SHARE_MAX * 100)}% объёма. Не взят — текст рано засчитывать прочитанным, а ступень рано повышать.`, '')
    out.push('| текст | ур. | слов | прочитан | отмечено сейчас | порог понятности |', '|---|---|---|---|---|---|')
    for (const t of texts) {
      const marks = markCount(lines, readingSrc(t.slug))
      const done = readSlugs.has(t.slug)
      const share = t.words ? ` (${((marks / t.words) * 100).toFixed(1)}%)` : ''
      const verdict = !done ? '—' : readingPassed(marks, t.words) ? '✅ взят' : '⚠️ не взят'
      out.push(`| ${cell(t.title, 60)} | ${t.level >= 999 ? '⚠' : t.level} | ${t.words} | ${done ? 'да' : '—'} | ${marks}${share} | ${verdict} |`)
    }
    out.push('')
  }

  out.push('## Незнакомые слова — отметки владельца', '')
  out.push('> Владелец отмечает слово касанием прямо в тексте или в условии задания. Кандидаты — те, которых в колоде сейчас нет: именно они должны стать карточками. Снятие отметки — отдельная строка журнала, а не удаление предыдущей.', '')
  const candidates = md.entries.filter(e => !e.inDeck)
  const alreadyInDeck = md.entries.filter(e => e.inDeck)
  out.push(`- Отмечено сейчас: **${md.total}** (в текстах ${md.fromReading} · в заданиях ${md.fromCards}) · разных слов ${md.entries.length}`)
  out.push(`- **Кандидаты в карточки (в колоде нет): ${candidates.length}**`)
  if (candidates.length) {
    out.push('', '| слово | отметок | где встретилось |', '|---|---|---|')
    for (const e of candidates.slice(0, CANDIDATE_CAP)) {
      out.push(`| ${e.lemma} | ${e.marks} | ${e.sample ? cell(e.sample) : '—'} |`)
    }
    if (candidates.length > CANDIDATE_CAP) out.push(`| … ещё ${candidates.length - CANDIDATE_CAP} | | |`)
    out.push('')
  }
  out.push(`- Отмечены при живой карточке (карточка есть, а слово не узнаётся — ПЕРЕФОРМУЛИРОВАТЬ, а не добавлять): ${alreadyInDeck.length ? alreadyInDeck.map(e => `${e.lemma}${e.marks > 1 ? ` ×${e.marks}` : ''}`).join(', ') : '—'}`)
  out.push('')

  out.push('## Нагрузка на 7 дней (план из FSRS)', '')
  out.push('| день | к повторению |', '|---|---|')
  for (let i = 0; i < 7; i++) {
    const d = addDaysKey(today, i)
    out.push(`| ${d}${i === 0 ? ' (сегодня, вкл. просроченное)' : ''} | ${load.get(d) ?? 0} |`)
  }
  out.push('')

  out.push('## План vs факт (последние 7 дней, межднёвные интервалы)', '')
  out.push('| день | сделано | вовремя | ср. просрочка, дн |', '|---|---|---|---|')
  for (const d of week) {
    const v = pvf.get(d)
    out.push(`| ${d} | ${v?.done ?? 0} | ${v ? v.onTime : 0} | ${v && v.done ? (v.delaySum / v.done).toFixed(1) : '0'} |`)
  }
  out.push('')

  out.push('## Проблемные слова', '')
  out.push(`- Пиявки (повторов ≥ 8 при стабильности < 2 дн — ПЕРЕФОРМУЛИРОВАТЬ, а не повторять): ${leeches.length ? leeches.map(v => `${v.word} (${v.fsrs.reps} показов, s=${v.fsrs.stability.toFixed(2)})`).join(', ') : '—'}`)
  out.push(`- Помечены leech-флагом (переформулировать карточку!): ${active.filter(v => v.leech).map(v => v.word).join(', ') || '—'}`)
  out.push(`- Ошибки написания (ввод, 14 дн): ${errList('type')}`)
  out.push(`- Ошибки предлогов (14 дн): ${errList('prep')}`)
  out.push(`- Ошибки выбора в контексте (MC, 14 дн): ${errList('mc')}`)
  // A6/A7: слово, которому показали знакомство и не дали ни одной отработки. Осталось New,
  // но с датой первого показа — в обучении не участвует, в прогрессе уровня не числится.
  // После правки планировщика (знакомство не выдаётся, если урок не может его отработать)
  // строка обязана быть пустой; непусто = либо старые данные, либо регрессия.
  const burnedIntro = active.filter(v => v.fsrs.state === State.New && !!cards.find(c => c.path === v.path)?.fm.first_seen)
  out.push(`- Знакомство без отработки (показано и брошено — должно быть пусто): ${burnedIntro.length ? burnedIntro.map(v => v.slug).join(', ') : '—'}`)
  const fewCtx = active.filter(v => v.kind === 'vocab' && v.fsrs.state === State.Review && v.contexts.length < 2)
  out.push(`- Нужны доп. контексты (review-слова с < 2 предложений — риск заучивания предложения): ${fewCtx.length ? fewCtx.map(v => v.word).join(', ') : '—'}`)
  out.push(`- Нужны confusables (review-слова без авторских дистракторов): ${active.filter(v => v.kind === 'vocab' && v.fsrs.state === State.Review && !v.confusables.length).slice(0, 20).map(v => v.word).join(', ') || '—'}`)
  out.push('')

  // линтер карточек: битые файлы ПОИМЁННО + структурные дефекты, которые делают карточку мёртвой или нечестной
  const brokenPaths = cards.filter(c => c.broken).map(c => c.path.split('/').pop())
  const badAnswer = active.filter(v => v.choices.length >= 2 && (!v.answerText || !v.choices.some(ch => ch.trim().toLowerCase() === v.answerText.trim().toLowerCase())))
  // пропуск проверяем в КАЖДОМ примере: ротация показывает любой из contexts, а не только первый.
  // Пример без пропуска печатается целиком (вместе с искомым словом) и уходит в FSRS как честный ответ
  const noBlank = active.filter(v => v.kind === 'vocab' && v.contexts.some(c => c && !/_{3,}/.test(c)))
  const noPrepBlank = active.filter(v => v.prep && v.prepContext && !/_{3,}/.test(v.prepContext))
  // словарь без уровня уедет в хвост-999 позади всех размеченных — «тихая смерть»: слово никогда не всплывёт
  const noLevel = active.filter(v => isLevelled(v) && v.level >= 999)
  if (brokenPaths.length || badAnswer.length || noBlank.length || noPrepBlank.length || noLevel.length) {
    out.push('## ⚠️ Дефекты карточек — исправить тьютору', '')
    if (brokenPaths.length) out.push(`- **Битый YAML (карточка исключена из обучения!):** ${brokenPaths.join(', ')}`)
    if (badAnswer.length) out.push(`- **answer отсутствует или не совпадает ни с одним choices (карточка невыигрываема):** ${badAnswer.map(v => v.slug).join(', ')}`)
    if (noBlank.length) out.push(`- Нет пропуска ______ в context: ${noBlank.map(v => v.slug).join(', ')}`)
    if (noPrepBlank.length) out.push(`- Нет пропуска ______ в prep_context: ${noPrepBlank.map(v => v.slug).join(', ')}`)
    if (noLevel.length) out.push(`- **vocab без level (уедет в хвост-999, не всплывёт при обычном темпе):** ${noLevel.map(v => v.slug).join(', ')}`)
    out.push('')
  }

  // закрытие пробелов: error/grammar/math — вычислимый graduation-статус
  const drill = active.filter(v => v.kind !== 'vocab')
  if (drill.length) {
    out.push('## Закрытие пробелов (error/grammar/math)', '')
    out.push('> Пробел можно помечать закрытым в Карте пробелов при ✅: ≥ 3 успешных повтора в РАЗНЫЕ дни и состояние review.', '')
    out.push('| карточка | домен | причина | сост. | успешных дней | статус |', '|---|---|---|---|---|---|')
    for (const v of drill) {
      const okDays = new Set(
        lines.filter(l => l.type === 'review' && l.slug === v.slug && (l.correct === true || (l.correct === undefined && (l.rating ?? 0) > 1))).map(l => l.day)
      ).size
      const grad = okDays >= 3 && v.fsrs.state === State.Review
      const rec = cards.find(c => c.path === v.path)
      out.push(`| ${v.word} | ${v.domain || '—'} | ${rec?.fm.cause ?? '—'} | ${STATE_RU[v.fsrs.state]} | ${okDays} | ${grad ? '✅ закрыт' : '⏳'} |`)
    }
    out.push('')
  }

  out.push('## Слова', '')
  out.push('| слово | ур. | добавлено | первый показ | сост. | стаб., дн | след. повтор | lapses | reps | prep |')
  out.push('|---|---|---|---|---|---|---|---|---|---|')
  const sorted = [...active].sort((a, b) => a.fsrs.due.getTime() - b.fsrs.due.getTime())
  const cap = 300
  for (const v of sorted.slice(0, cap)) {
    const rec = cards.find(c => c.path === v.path)
    const firstSeen = rec?.fm.first_seen ?? '—'
    const added = rec?.fm.added ?? '—'
    const lv = isLevelled(v) ? (v.level >= 999 ? '⚠' : String(v.level)) : '—'
    const prep = v.prep
      ? `${v.prep} · ${STATE_RU[v.fsrsPrep!.state]}${v.fsrsPrep!.state !== State.New ? ' · ' + fmtDay(v.fsrsPrep!.due) : ''}`
      : '—'
    out.push(`| ${v.word} | ${lv} | ${added} | ${firstSeen} | ${STATE_RU[v.fsrs.state]} | ${v.fsrs.stability ? v.fsrs.stability.toFixed(1) : '0'} | ${v.fsrs.state === State.New ? '—' : fmtDay(v.fsrs.due)} | ${v.fsrs.lapses} | ${v.fsrs.reps} | ${prep} |`)
  }
  if (sorted.length > cap) out.push(`| … ещё ${sorted.length - cap} | | | | | | | | | |`)
  out.push('')
  return out.join('\n')
}
