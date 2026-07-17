import { State } from 'ts-fsrs'
import type { JournalLine, JournalRec } from './types'
import { addDaysKey, dayKey } from './daytime'

export const MIN_MINUTES = 15          // защищённый минимум
export const CARD_TIME_CAP_MS = 60_000 // AFK-защита: на карточку в зачёт минут — максимум 60 c

export function newId(): string {
  return crypto.randomUUID()
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

/** Серия: подряд закрытые дни, заканчивая сегодня (или вчера, если сегодня ещё не закрыт — серия не потеряна, но и не увеличена). */
export function streak(lines: JournalLine[], today: string = dayKey()): { days: number; todayDone: boolean } {
  const minutes = minutesByDay(lines)
  const empty = emptyDays(lines)
  const todayDone = isDayDone(today, minutes, empty)
  let d = todayDone ? today : addDaysKey(today, -1)
  let n = 0
  while (isDayDone(d, minutes, empty)) {
    n++
    d = addDaysKey(d, -1)
  }
  return { days: n, todayDone }
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

/** Сколько новых карточек уже введено в этот учебный день */
export function newIntroducedOn(lines: JournalLine[], day: string): number {
  const seen = new Set<string>()
  for (const l of lines) {
    if (l.type === 'review' && l.day === day && l.prev_state === State.New && l.slug) seen.add(l.slug)
  }
  return seen.size
}

export function minutesToday(lines: JournalLine[], today: string = dayKey()): number {
  return minutesByDay(lines).get(today) ?? 0
}
