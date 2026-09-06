import { State } from 'ts-fsrs'
import type { CardRec, CardView, JournalRec, JournalLine, ReadingRec } from './types'
import { cardView, readingView } from './yamlfm'
import { addDaysKey, dayKey, isoLocal } from './daytime'
import {
  minutesByDay, readMinutesByDay, streak, trueRetention30, retentionByFormat, READ_MIN_MINUTES,
  markDigest, markCount, readingSrc, readingPassed, readTextSlugs, readTextsToday, readingPaceWpm, normWord,
  READING_UNKNOWN_SHARE_MAX, READ_MIN_TEXTS, reviewsByDay, dayUnitsByDay, practiceUnitsByDay,
  practiceMinutesByDay, type PauseRange
} from './journal'
import { activeLevel, levelStats, isLevelled, EXAM_DATE, SECTIONS, nextAttempt, dueCap, phase, NEW_STOP_BY_SECTION } from './scheduler'
import {
  examReady, maturity, pace, retentionByInterval, retentionByLateness, retentionBySection, maturityBySection,
  speedStats, typoSplit, gaveUpShare, cuedStats, planVsFact, isLeechCard, orphanedLines, ddmm, practiceUnitRatio,
  capacityEstimate,
  NEW_STOP_DATE, TARGET_REVIEW, TARGET_MATURE, MATURE_STABILITY_DAYS, READY_R,
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

  /* Зачёт дня по трём каналам (WS6a, D4): оценки карточек + практика в единицах
     (коэффициент - practiceUnitRatio, по замеренным медианам, с полом на нехватке
     выборки), плюс минуты практики отдельным слагаемым к минутам SRS. Раньше
     сорокаминутная практика писала "минут сегодня: 0" и "упражнений: 0" - канал
     существовал в журнале, но нигде не считался. */
  const ratio = practiceUnitRatio(lines)
  const st = streak(lines, today, pause, ratio)
  const minutes = minutesByDay(lines)
  const practiceMin = practiceMinutesByDay(lines)
  const reviews = reviewsByDay(lines)
  const units = dayUnitsByDay(lines, ratio)
  const practiceUnits = practiceUnitsByDay(lines, ratio)
  const ret = trueRetention30(lines, today)
  const retF = retentionByFormat(lines, today)
  const sp = speedStats(lines)
  const ts = typoSplit(lines)
  const gu = gaveUpShare(lines)   // за всю историю; дневной срез уже копится в _метрики.ndjson
  const cs = cuedStats(lines, now)   // C12: доля показов type, взятых со ступенчатой подсказки

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
  const practiceMin7 = week.reduce((a, d) => a + (practiceMin.get(d) ?? 0), 0)
  // Чтение - вторая половина защищённого минимума и половина работы над SAT, но в отчёт
  // не попадало ни разу, и «0/7 (не трекается)» семь недель никто не видел глазами.
  const readMin = readMinutesByDay(lines)
  const read7 = week.reduce((a, d) => a + (readMin.get(d) ?? 0), 0)
  const weekLines = lines.filter(l => l.day && week.includes(l.day))
  const textsWeek = readTextSlugs(weekLines).size
  const textsToday = readTextsToday(lines, today)

  const out: string[] = []
  out.push('---', 'type: report', 'report_schema: 1', `updated: "${isoLocal(now)}"`, '---', '')
  out.push('# SRS-отчёт (автогенерация)', '')
  out.push('> Файл пишет приложение SAT SRS при каждой синхронизации — не редактировать. Источник сырых данных: `_журнал/*.ndjson` (каждая оценка: ts, слово, навык, формат, correct, rating, план следующего показа) и frontmatter карточек.', '')

  /* Главное число сменилось 06.09.2026. Цель TARGET_REVIEW и измеренная ёмкость
     разъехались вчетверо: отчёт требовал «довести ещё 219, +14,6/день, отстаёшь
     на 68 дн» при 28 днях до попытки и медиане 2,4 доведения в день - тот же
     прецедент, что и «400 готовых слов» 17.08.2026 (см. комментарий у
     capacityEstimate в metrics.ts). Цифра, которую нельзя выполнить измеренным
     темпом, не мотивирует, а деморализует, и держать её главной строкой отчёта -
     повторять уже отменённую ошибку.

     Главное число теперь - готовность к БЛИЖАЙШЕЙ попытке по прогнозной
     retrievability (D7): вспомнится слово или нет при выполнении плана повторов,
     а не сколько карточек формально доведено до состояния review. Цель ниже
     строится не как желаемое число, а как то, на что хватает измеренной ёмкости
     (capacityEstimate/wordsAffordable/rulesAffordable, metrics.ts) - недостижимая
     цель на экране и в отчёте больше не показывается. */
  /* Даты берутся у планировщика в момент отчёта (E3), а не у константы первой попытки:
     отчёт уезжает тьютору и после 03.10, и «готовность к 03.10» в нём была бы отчётом
     о прошедшем дне. attempt - ближайшая попытка, cap - потолок сроков на сегодня. */
  const attempt = nextAttempt(now)
  const dueCapNow = dueCap(now)
  const erP = examReady(active, attempt)
  const erE = examReady(active, EXAM_DATE)
  const pc = pace(active, lines, NEW_STOP_DATE, now)
  const ce = capacityEstimate(lines, now, NEW_STOP_DATE)
  const mat = maturity(active)
  out.push('## Прогресс к экзамену', '')
  const stopsStr = SECTIONS.map(s2 => `${SECTION_LABELS[s2]} ${ddmm(NEW_STOP_BY_SECTION[s2])}`).join(' · ')
  out.push(`> Главное число сменилось 06.09.2026 (прецедент 17.08.2026 с «400 готовых слов»): цель, которую измеренная ёмкость не вытягивает, на экране и в отчёте больше не показывается. Ввод новых закрывается у каждого раздела своей датой (A8): ${stopsStr}; последний рабочий день ввода - накануне, дальше только дозревание введённого. Потолок сроков на сегодня: ${ddmm(dueCapNow)}.`, '')
  const readyTail = attempt.getTime() === EXAM_DATE.getTime() ? '' : ` · к ${ddmm(EXAM_DATE)} ${erE.ready}`
  out.push(`- Вспомнится к ${ddmm(attempt)}: **${erP.ready}** из ${erP.total} слов (прогноз R ≥ ${READY_R} при выполнении плана повторов)${readyTail}`)
  out.push(`- Ёмкости до ${ddmm(NEW_STOP_DATE)} хватит на **~${pc.wordsAffordable} слов** или **~${pc.rulesAffordable} правил SEC** (измерено по журналу занятий, capacity=${pc.capacity} оценок)`)
  out.push(`- Выполнимый дневной объём: **${ce.gradesPerStudyDay}** оценок (медиана в учебный день, ${Math.round(ce.studyFrequency * 100)}% дней с занятиями)`)
  out.push(`- В review (словарные карточки, справочный коридор): ${mat.reviewCount} из ${TARGET_REVIEW} · зрелых к ${ddmm(EXAM_DATE)} (стаб.≥${MATURE_STABILITY_DAYS}дн): ${mat.matureCount} из ${TARGET_MATURE} · медианная стабильность ${mat.medianStability} дн`)
  out.push(`- Темп: +${pc.actual7} за 7 дн · +${pc.actual14} за 14 дн (выход в review по журналу)`)
  /* Финальный проход: в последнюю неделю потолок сроков стоит на кануне попытки, и весь
     этот объём обязан пройти перед экзаменом. Тьютору нужна не сама дата, а число: это
     нагрузка, которую ученик либо возьмёт, либо не возьмёт. */
  if (phase(now) === 'final') {
    const finalPass = active.filter(v => v.fsrs.state !== State.New && v.fsrs.due.getTime() <= dueCapNow.getTime()).length
    out.push(`- Финальный проход перед ${ddmm(attempt)}: **${finalPass}** карточек со сроком до ${ddmm(dueCapNow)} (потолок сроков съехал на канун попытки)`)
  }
  const byLv = erP.byLevel.filter(l => l.level < 999)
  if (byLv.length) out.push(`- Готовность по ступеням: ${byLv.map(l => `L${l.level} ${l.ready}/${l.total}`).join(' · ')}`)
  const ri = retentionByInterval(lines)
  const riParts = (Object.keys(ri) as IntervalBucket[]).map(k => `${INTERVAL_LABELS[k]} ${ri[k].pct === null ? '—' : ri[k].pct + '%'}${ri[k].n ? ` (n=${ri[k].n})` : ''}`)
  out.push(`- Retention по бакетам интервала: ${riParts.join(' · ')}`)
  // Разрез по сроку показа - вовремя или с просрочкой, отдельно от расстояния между показами
  // (retentionByLateness, metrics.ts): бакет интервала и просрочка исполнения - два разных
  // вопроса, и второй раньше не отвечался нигде.
  const rl = retentionByLateness(lines)
  const latenessPart = (b: typeof rl.onTime) => (b.pct === null ? 'нет данных' : `${b.pct}%`) + (b.n ? ` (n=${b.n})` : '')
  out.push(`- Retention по сроку: вовремя ${latenessPart(rl.onTime)} · с просрочкой ${latenessPart(rl.overdue)}${rl.avgDelayDays !== null ? ` (ср. просрочка ${rl.avgDelayDays} дн)` : ''}`)
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
  const reworkedSuffix = orph.reworked.length
    ? ` · переработанные пиявки (история обнулена осознанно): ${orph.reworked.map(s => `${s.slug} ×${s.n}`).join(', ')}`
    : ''
  out.push((orph.n
    ? `- Осиротевшие строки журнала (slug карточки пропал из колоды - переработка/переименование): **${orph.n} из ${orph.total} (${Math.round(orph.share * 100)}%)** · ${orph.slugs.map(s => `${s.slug} ×${s.n}`).join(', ')}`
    : `- Осиротевшие строки журнала: нет - все ${orph.total} строк со slug привязаны к карточкам колоды`) + reworkedSuffix)
  const ms = maturityBySection(active)
  const msParts = SECTIONS.map(s => `${SECTION_LABELS[s]} review ${ms[s].reviewCount}/${ms[s].total} · зрелых ${ms[s].matureCount}/${ms[s].total}`)
  out.push(`- В review / зрелых по разделам: ${msParts.join(' · ')}`)
  out.push('')

  out.push('## Сводка', '')
  out.push(`- Слов: **${active.length}** (new ${byState.new} · learning ${byState.learning} · review ${byState.review}; здесь все разделы и prep, поэтому review больше словарного числа из «Прогресса») · prep-навыков: ${prepCount}${brokenCount ? ` · битых файлов: ⚠️ ${brokenCount}` : ''}`)
  const actLv = activeLevel(active)
  const lvStats = levelStats(active)
  const curLv = lvStats.find(s => s.level === actLv)
  if (curLv) out.push(`- Активный уровень: **${actLv}** (введено ${curLv.introduced}/${curLv.total} · в review ${curLv.review}) · всего уровней: ${lvStats.length}`)
  const minutesTodayTotal = (minutes.get(today) ?? 0) + (practiceMin.get(today) ?? 0)
  const minutes7Total = min7 + practiceMin7
  out.push(`- Серия: **${st.days} дн** (${st.todayDone ? 'сегодня зачтён' : 'сегодня НЕ зачтён'}) · минут сегодня: ${Math.round(minutesTodayTotal)} (SRS ${Math.round(minutes.get(today) ?? 0)} + практика ${Math.round(practiceMin.get(today) ?? 0)}) · за 7 дн: ${Math.round(minutes7Total)}`)
  /* Упражнений дня - оценки карточек + практика в единицах (dayUnitsByDay, WS6a):
     день зачитывается по units (см. isDayDone в journal.ts), а практика без единой
     оценки карточки день не закрывает - строка ниже показывает оба слагаемых, а не
     только сумму, чтобы расхождение с isDayDone было видно тьютору сразу. */
  out.push(`- Упражнений сегодня: **${Math.round(units.get(today) ?? 0)}** (карточки ${reviews.get(today) ?? 0} · практика ${Math.round(practiceUnits.get(today) ?? 0)} в единицах, коэффициент ${ratio})`)
  out.push(`- Чтение: текстов за 7 дн **${textsWeek}**, норма ${READ_MIN_TEXTS}/день${textsToday ? ` (сегодня прочитано: ${textsToday})` : ''} · минут чтения сегодня: ${Math.round(readMin.get(today) ?? 0)} · за 7 дн: ${Math.round(read7)} (справочно, ${READ_MIN_MINUTES} мин/день не является нормой)`)
  out.push(`- True retention 30 дн (review-показы): **${ret.pct === null ? '—' : ret.pct + '%'}**${ret.n ? ` (n=${ret.n})` : ''}`)
  const fmtNames: Record<string, string> = { mc: 'MC', type: 'ввод', prep: 'предлоги', reveal: 'показ' }
  const retParts = Object.entries(retF).map(([f, v]) => `${fmtNames[f] ?? f} ${pct(v.pass, v.total)}`)
  if (retParts.length) out.push(`- По форматам: ${retParts.join(' · ')}`)
  /* Три метрики ниже (скорость по видам, «не помню», опечатки vs незнание) считались
     в metrics.ts и раньше, но не попадали ни на экран, ни в отчёт — тьютор их не видел
     нигде. «Не помню» — прямой признак того, что ученик перестал пытаться вспомнить. */
  const kindNames: Record<string, string> = { vocab: 'слово', grammar: 'грамматика', math: 'математика', error: 'разбор ошибки' }
  const kindParts = Object.entries(sp.byKind).map(([k, v]) => `${kindNames[k] ?? k} ${(v.medianMs / 1000).toFixed(1)} c (n=${v.n})`)
  /* F20: подпись «время ответа», не «скорость» - число уже не время до кнопки «Дальше»
     (то включало чтение вердикта/разбора), а время до самого ответа, когда оно
     известно. Доля чистых замеров показывает тьютору, насколько порог «медленно»
     уже очищен от старых строк, где такого различения не было. */
  if (kindParts.length) out.push(`- Время ответа по видам карточек (медиана): ${kindParts.join(' · ')} · чистых замеров (без чтения разбора) ${Math.round(sp.cleanShare * 100)}%`)
  out.push(`- «Не помню» вместо попытки вспомнить (вся история, интро не считается): ${pct(gu.gaveUp, gu.n)}`)
  const typoTotal = ts.typos + ts.realMisses
  out.push(`- Ошибки ввода слова: опечаток ${ts.typos} · настоящих незнаний ${ts.realMisses}${typoTotal ? ` (доля опечаток ${Math.round((ts.typos / typoTotal) * 100)}%, n=${typoTotal})` : ''}`)
  out.push(`- Ввод с подсказкой: ${cs.d7.cued} из ${cs.d7.shown} показов type за 7 дней (за 30 дней: ${cs.d30.cued} из ${cs.d30.shown})`)
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
    out.push('| текст | ур. | слов | прочитан | отмечено сейчас | темп | порог понятности |', '|---|---|---|---|---|---|---|')
    for (const t of texts) {
      const marks = markCount(lines, readingSrc(t.slug))
      const done = readSlugs.has(t.slug)
      const share = t.words ? ` (${((marks / t.words) * 100).toFixed(1)}%)` : ''
      const verdict = !done ? '—' : readingPassed(marks, t.words) ? '✅ взят' : '⚠️ не взят'
      /* Прочерк значит «не мерили», а не «медленно»: время над текстом приложение считает
         только с 22.08.2026, у прочтений до того поля `read_s` нет вовсе. */
      const wpm = readingPaceWpm(lines, t.slug, t.words)
      out.push(`| ${cell(t.title, 60)} | ${t.level >= 999 ? '⚠' : t.level} | ${t.words} | ${done ? 'да' : '—'} | ${marks}${share} | ${wpm ? `${wpm} сл/мин` : '—'} | ${verdict} |`)
    }
    out.push('')
  }

  out.push('## Незнакомые слова — отметки владельца', '')
  out.push('> Владелец отмечает слово касанием прямо в тексте, в условии задания или в настоящем вопросе SAT. Кандидаты — те, которых в колоде сейчас нет: именно они должны стать карточками. Отметка в вопросе SAT — самая дорогая из трёх: это язык самого экзамена. Снятие отметки — отдельная строка журнала, а не удаление предыдущей.', '')
  const candidates = md.entries.filter(e => !e.inDeck)
  const alreadyInDeck = md.entries.filter(e => e.inDeck)
  out.push(`- Отмечено сейчас: **${md.total}** (в текстах ${md.fromReading} · в заданиях ${md.fromCards} · в вопросах SAT ${md.fromQuestions}) · разных слов ${md.entries.length}`)
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

  out.push(`## Нагрузка на 7 дней (план из FSRS, потолок сроков ${ddmm(dueCapNow)})`, '')
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
