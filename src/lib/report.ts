import { State } from 'ts-fsrs'
import type { CardRec, JournalRec, JournalLine } from './types'
import { cardView } from './yamlfm'
import { addDaysKey, dayKey, isoLocal } from './daytime'
import { minutesByDay, streak, trueRetention30, type PauseRange } from './journal'
import { activeLevel, levelStats, isLevelled } from './scheduler'

/**
 * Автогенерируемый отчёт для ИИ-тьютора: `_отчёт.md` рядом с карточками.
 * Перезаписывается при каждой синхронизации. Только чтение для тьютора:
 * сводка, план vs факт, прогноз нагрузки, проблемные слова, полная таблица.
 */

const STATE_RU: Record<number, string> = { 0: 'new', 1: 'learning', 2: 'review', 3: 'relearning' }

const fmtDay = (d: Date) => dayKey(d)
const dueDay = (iso: string) => {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : fmtDay(d)
}

function pct(part: number, total: number): string {
  return total ? `${Math.round((part / total) * 100)}% (n=${total})` : '—'
}

/** Ретеншн по формату за 30 дней: у объективных — по correct, у reveal — rating>1 */
function retentionByFormat(lines: JournalLine[], today: string): Record<string, { pass: number; total: number }> {
  const from = addDaysKey(today, -29)
  const acc: Record<string, { pass: number; total: number }> = {}
  for (const l of lines) {
    if (l.type !== 'review' || !l.day || l.day < from) continue
    if (l.prev_state !== State.Review) continue
    const f = l.format ?? 'reveal'
    acc[f] ??= { pass: 0, total: 0 }
    acc[f].total++
    const ok = l.correct !== undefined ? l.correct : (l.rating ?? 0) > 1
    if (ok) acc[f].pass++
  }
  return acc
}

/** План vs факт: по каждой паре соседних ревью одного (слово×навык) — планировался день X, случился день Y */
function planVsFact(lines: JournalLine[], today: string) {
  const from = addDaysKey(today, -6)
  const byItem = new Map<string, JournalLine[]>()
  for (const l of lines) {
    if (l.type !== 'review' || !l.slug) continue
    const key = `${l.slug}#${l.skill ?? 'recall'}`
    if (!byItem.has(key)) byItem.set(key, [])
    byItem.get(key)!.push(l)
  }
  const perDay = new Map<string, { done: number; onTime: number; delaySum: number }>()
  for (const seq of byItem.values()) {
    seq.sort((a, b) => a.ts.localeCompare(b.ts))
    for (let i = 1; i < seq.length; i++) {
      const planned = seq[i - 1].due ? dueDay(seq[i - 1].due!) : ''
      const actual = seq[i].day
      if (!planned || !actual || actual < from || actual > today) continue
      // учебные шаги внутри дня (learning) не считаем просрочкой/планом — интересуют межднёвные интервалы
      if (planned === seq[i - 1].day && actual === planned) continue
      const delay = Math.round((Date.parse(actual) - Date.parse(planned)) / 86400_000)
      const d = perDay.get(actual) ?? { done: 0, onTime: 0, delaySum: 0 }
      d.done++
      if (delay <= 0) d.onTime++
      d.delaySum += Math.max(0, delay)
      perDay.set(actual, d)
    }
  }
  return perDay
}

export function buildReport(cards: CardRec[], journal: JournalRec[], now: Date = new Date(), pause?: PauseRange | null): string {
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

  // проблемные слова
  const leeches = active
    .filter(v => v.fsrs.lapses >= 3 || (v.fsrsPrep?.lapses ?? 0) >= 3)
    .sort((a, b) => (b.fsrs.lapses + (b.fsrsPrep?.lapses ?? 0)) - (a.fsrs.lapses + (a.fsrsPrep?.lapses ?? 0)))
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

  const out: string[] = []
  out.push('---', 'type: report', 'report_schema: 1', `updated: "${isoLocal(now)}"`, '---', '')
  out.push('# SRS-отчёт (автогенерация)', '')
  out.push('> Файл пишет приложение SAT SRS при каждой синхронизации — не редактировать. Источник сырых данных: `_журнал/*.ndjson` (каждая оценка: ts, слово, навык, формат, correct, rating, план следующего показа) и frontmatter карточек.', '')

  out.push('## Сводка', '')
  out.push(`- Слов: **${active.length}** (new ${byState.new} · learning ${byState.learning} · review ${byState.review}) · prep-навыков: ${prepCount}${brokenCount ? ` · битых файлов: ⚠️ ${brokenCount}` : ''}`)
  const actLv = activeLevel(active)
  const lvStats = levelStats(active)
  const curLv = lvStats.find(s => s.level === actLv)
  if (curLv) out.push(`- Активный уровень: **${actLv}** (введено ${curLv.introduced}/${curLv.total} · в review ${curLv.review}) · всего уровней: ${lvStats.length}`)
  out.push(`- Серия: **${st.days} дн** (${st.todayDone ? 'сегодня зачтён' : 'сегодня НЕ зачтён'}) · минут сегодня: ${Math.round(minutes.get(today) ?? 0)} · за 7 дн: ${Math.round(min7)}`)
  out.push(`- True retention 30 дн (review-показы): **${ret.pct === null ? '—' : ret.pct + '%'}**${ret.n ? ` (n=${ret.n})` : ''}`)
  const fmtNames: Record<string, string> = { mc: 'MC', type: 'ввод', prep: 'предлоги', reveal: 'показ' }
  const retParts = Object.entries(retF).map(([f, v]) => `${fmtNames[f] ?? f} ${pct(v.pass, v.total)}`)
  if (retParts.length) out.push(`- По форматам: ${retParts.join(' · ')}`)
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
  out.push(`- Пиявки (lapses ≥ 3): ${leeches.length ? leeches.map(v => `${v.word} (${v.fsrs.lapses}${v.fsrsPrep?.lapses ? '+' + v.fsrsPrep.lapses + 'prep' : ''})`).join(', ') : '—'}`)
  out.push(`- Помечены leech-флагом (переформулировать карточку!): ${active.filter(v => v.leech).map(v => v.word).join(', ') || '—'}`)
  out.push(`- Ошибки написания (ввод, 14 дн): ${errList('type')}`)
  out.push(`- Ошибки предлогов (14 дн): ${errList('prep')}`)
  out.push(`- Ошибки выбора в контексте (MC, 14 дн): ${errList('mc')}`)
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
