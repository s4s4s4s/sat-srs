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

export function parseNdjson(text: string): JournalLine[] {
  const out: JournalLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const o = JSON.parse(line)
      if (o && typeof o === 'object' && o.id) out.push(o as JournalLine)
    } catch { /* битую строку пропускаем */ }
  }
  return out
}

export function toNdjson(lines: JournalLine[]): string {
  const sorted = [...lines].sort((a, b) => a.ts.localeCompare(b.ts))
  return sorted.map(l => JSON.stringify(stripSynced(l))).join('\n') + (sorted.length ? '\n' : '')
}

function stripSynced(l: JournalLine): JournalLine {
  const { ...rest } = l as JournalRec
  delete (rest as any).synced
  return rest
}

/** Минуты ревью по дням (с капом на карточку) */
export function minutesByDay(lines: JournalLine[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of lines) {
    if (l.type !== 'review') continue
    const ms = Math.min(l.elapsed_ms ?? 0, CARD_TIME_CAP_MS)
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
}

/**
 * Серия с заморозками (проход вперёд от первого дня журнала):
 * закрытый день продолжает серию, каждые 7 подряд дают заморозку (банк ≤ 2),
 * пропущенный день сжигает заморозку вместо серии; сегодня не судим до конца дня.
 */
export function streak(lines: JournalLine[], today: string = dayKey()): StreakInfo {
  const minutes = minutesByDay(lines)
  const empty = emptyDays(lines)
  const done = (d: string) => isDayDone(d, minutes, empty)
  const activeDays = [...new Set(lines.map(l => l.day))].filter(Boolean).sort()
  if (!activeDays.length) return { days: 0, todayDone: false, freezes: 0, toFreeze: 7 }

  let run = 0
  let bank = 0
  let sinceEarn = 0
  let d = activeDays[0]
  while (d < today) {
    if (done(d)) {
      run++
      sinceEarn++
      if (sinceEarn >= 7) { bank = Math.min(2, bank + 1); sinceEarn = 0 }
    } else if (bank > 0) {
      bank-- // заморозка сгорает вместо серии
    } else {
      run = 0
      sinceEarn = 0
    }
    d = addDaysKey(d, 1)
  }
  const todayDone = done(today)
  if (todayDone) {
    run++
    sinceEarn++
    if (sinceEarn >= 7) { bank = Math.min(2, bank + 1); sinceEarn = 0 }
  }
  return { days: run, todayDone, freezes: bank, toFreeze: bank >= 2 ? 0 : 7 - sinceEarn }
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
