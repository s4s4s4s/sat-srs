import { State } from 'ts-fsrs'
import type { JournalLine, JournalRec } from './types'
import { addDaysKey, dayKey } from './daytime'

export const MIN_MINUTES = 15          // защищённый минимум
export const CARD_TIME_CAP_MS = 60_000 // AFK-защита: на карточку в зачёт минут — максимум 60 c

export function newId(): string {
  // crypto.randomUUID есть только в secure context и Safari ≥ 15.4 — фолбэк на getRandomValues
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * Разбор ndjson: валидная строка обязана иметь строковые id, ts и day.
 * Невалидные-но-непустые строки возвращаются сырыми — при перезаписи месяца
 * они сохраняются как есть (чужие данные не теряем и не даём одной кривой
 * строке заблокировать push со всех устройств).
 */
export function parseNdjson(text: string): { lines: JournalLine[]; rejects: string[] } {
  const lines: JournalLine[] = []
  const rejects: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const o = JSON.parse(line)
      if (o && typeof o === 'object' && typeof o.id === 'string' && typeof o.ts === 'string' && typeof o.day === 'string') {
        lines.push(o as JournalLine)
      } else {
        rejects.push(line)
      }
    } catch {
      rejects.push(line)
    }
  }
  return { lines, rejects }
}

export function toNdjson(lines: JournalLine[], rawExtras: string[] = []): string {
  const key = (l: JournalLine) => (typeof l.ts === 'string' ? l.ts : '')
  const sorted = [...lines].sort((a, b) => key(a).localeCompare(key(b)))
  const body = sorted.map(l => JSON.stringify(stripSynced(l)))
  const all = [...body, ...rawExtras]
  return all.join('\n') + (all.length ? '\n' : '')
}

function stripSynced(l: JournalLine): JournalLine {
  const { ...rest } = l as JournalRec
  delete (rest as any).synced
  return rest
}

/** Кап зачётного времени на карточку: math-задачи решаются дольше слов */
export function cardTimeCap(kind?: string): number {
  return kind === 'math' ? 180_000 : CARD_TIME_CAP_MS
}

/** Минуты ревью по дням (с капом на карточку) */
export function minutesByDay(lines: JournalLine[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of lines) {
    if (l.type !== 'review') continue
    const ms = Math.min(l.elapsed_ms ?? 0, cardTimeCap(l.kind))
    m.set(l.day, (m.get(l.day) ?? 0) + ms / 60000)
  }
  return m
}

/** Дни, где очередь была добита до конца */
export function emptyDays(lines: JournalLine[]): Set<string> {
  const s = new Set<string>()
  for (const l of lines) if (l.type === 'session' && l.queue_empty) s.add(l.day)
  return s
}

export function isDayDone(day: string, minutes: Map<string, number>, empty: Set<string>): boolean {
  return (minutes.get(day) ?? 0) >= MIN_MINUTES || empty.has(day)
}

export interface StreakInfo {
  days: number
  todayDone: boolean
  freezes: number // банк заморозок: 1 за каждые 7 закрытых дней подряд, максимум 2
  toFreeze: number // дней до следующей заморозки (0 = банк полон)
  pausedToday: boolean // сегодня — плановая пауза (переезд)
  freezeSpentYesterday: boolean // вчера заморозка спасла серию — сказать об этом
}

export interface PauseRange { from: string; to: string }

/**
 * Серия с заморозками (проход вперёд от первого дня журнала):
 * закрытый день продолжает серию, каждые 7 подряд дают заморозку (банк ≤ 2),
 * пропущенный день сжигает заморозку вместо серии; сегодня не судим до конца дня.
 * Дни плановой паузы прозрачны: серия не рвётся, не растёт, заморозки не тратятся.
 */
export function streak(lines: JournalLine[], today: string = dayKey(), pause?: PauseRange | null): StreakInfo {
  const minutes = minutesByDay(lines)
  const empty = emptyDays(lines)
  const done = (d: string) => isDayDone(d, minutes, empty)
  const inPause = (d: string) => !!(pause && pause.from && pause.to && d >= pause.from && d <= pause.to)
  const activeDays = [...new Set(lines.map(l => l.day))].filter(Boolean).sort()
  if (!activeDays.length) return { days: 0, todayDone: false, freezes: 0, toFreeze: 7, pausedToday: inPause(today), freezeSpentYesterday: false }

  const yesterday = addDaysKey(today, -1)
  let run = 0
  let bank = 0
  let sinceEarn = 0
  let freezeSpentYesterday = false
  let d = activeDays[0]
  while (d < today) {
    if (inPause(d)) {
      // пауза: день прозрачен (но занятия в паузе всё равно засчитываются в run)
      if (done(d)) { run++ }
    } else if (done(d)) {
      run++
      sinceEarn++
      if (sinceEarn >= 7) { bank = Math.min(2, bank + 1); sinceEarn = 0 }
    } else if (bank > 0) {
      bank-- // заморозка сгорает вместо серии
      if (d === yesterday) freezeSpentYesterday = true
    } else {
      run = 0
      sinceEarn = 0
    }
    d = addDaysKey(d, 1)
  }
  const todayDone = done(today)
  if (todayDone) {
    run++
    if (!inPause(today)) {
      sinceEarn++
      if (sinceEarn >= 7) { bank = Math.min(2, bank + 1); sinceEarn = 0 }
    }
  }
  return { days: run, todayDone, freezes: bank, toFreeze: bank >= 2 ? 0 : 7 - sinceEarn, pausedToday: inPause(today), freezeSpentYesterday }
}

/** Точность по форматам за 30 дней (review-показы): mc/type/prep — по correct, reveal — по rating>1 */
export function retentionByFormat(lines: JournalLine[], today: string = dayKey()): Record<string, { pass: number; total: number }> {
  const from = addDaysKey(today, -29)
  const acc: Record<string, { pass: number; total: number }> = {}
  for (const l of lines) {
    if (l.type !== 'review' || !l.day || l.day < from) continue
    if (l.prev_state !== State.Review) continue
    const f = l.format ?? 'reveal'
    if (f === 'intro') continue
    acc[f] ??= { pass: 0, total: 0 }
    acc[f].total++
    const ok = l.correct !== undefined ? l.correct : (l.rating ?? 0) > 1
    if (ok) acc[f].pass++
  }
  return acc
}

/** True retention за 30 дней: доля rating>1 среди оценок карточек в состоянии Review */
export function trueRetention30(lines: JournalLine[], today: string = dayKey()): { pct: number | null; n: number } {
  const from = addDaysKey(today, -29)
  let pass = 0
  let total = 0
  for (const l of lines) {
    if (l.type !== 'review' || l.prev_state !== State.Review) continue
    if (l.day < from || l.day > today) continue
    total++
    if ((l.rating ?? 0) > 1) pass++
  }
  return { pct: total ? Math.round((pass / total) * 100) : null, n: total }
}

/** Сколько новых учебных единиц (слово × навык) уже введено в этот учебный день */
export function newIntroducedOn(lines: JournalLine[], day: string): number {
  const seen = new Set<string>()
  for (const l of lines) {
    if (l.type === 'review' && l.day === day && l.prev_state === State.New && l.slug) {
      seen.add(`${l.slug}#${l.skill ?? 'recall'}`)
    }
  }
  return seen.size
}

export function minutesToday(lines: JournalLine[], today: string = dayKey()): number {
  return minutesByDay(lines).get(today) ?? 0
}

/**
 * Слова, введённые в этот учебный день и подлежащие обязательной отработке (point 3/4).
 * Механизм — вывод из журнала (без нового поля в карточке): слово считается введённым
 * сегодня, если у него есть recall-строка этого дня с format:intro или prev_state:0.
 * Пометка снимается, когда слово отработано (не-intro recall) в ДВУХ отдельных сессиях
 * ПОСЛЕ сессии знакомства — сессии разделяются строками type:session. До этого слово
 * принудительно добирается в последующие уроки дня; со сменой учебного дня список пуст.
 */
export function forcedTodaySlugs(lines: JournalLine[], today: string = dayKey()): Set<string> {
  const todays = lines
    .filter(l => l.day === today && (l.type === 'review' || l.type === 'session'))
    .sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''))
  let block = 0
  const introBlock = new Map<string, number>()      // slug → индекс сессии знакомства
  const laterPractice = new Map<string, Set<number>>() // slug → индексы сессий с отработкой после знакомства
  for (const l of todays) {
    if (l.type === 'session') { block++; continue }
    if ((l.skill ?? 'recall') !== 'recall' || !l.slug) continue
    const isIntro = l.format === 'intro' || l.prev_state === State.New
    if (isIntro && !introBlock.has(l.slug)) introBlock.set(l.slug, block)
    const intro = introBlock.get(l.slug)
    if (intro !== undefined && block > intro && l.format !== 'intro') {
      const s = laterPractice.get(l.slug) ?? new Set<number>()
      s.add(block)
      laterPractice.set(l.slug, s)
    }
  }
  const out = new Set<string>()
  for (const slug of introBlock.keys()) {
    if ((laterPractice.get(slug)?.size ?? 0) < 2) out.add(slug)
  }
  return out
}
