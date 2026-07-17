/** Логика «учебного дня»: локальный день с переносом границы в 04:00 (занятия за полночь не ломают серию и лимиты). */

export const ROLLOVER_H = 4

const pad = (n: number) => String(n).padStart(2, '0')

/** YYYY-MM-DD локального учебного дня для момента t */
export function dayKey(t: Date = new Date()): string {
  const d = new Date(t.getTime() - ROLLOVER_H * 3600_000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Конец текущего учебного дня (следующие 04:00 локального времени) */
export function endOfStudyDay(t: Date = new Date()): Date {
  const d = new Date(t)
  d.setHours(ROLLOVER_H, 0, 0, 0)
  if (t.getHours() >= ROLLOVER_H) d.setDate(d.getDate() + 1)
  return d
}

export function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const dt = new Date(y, m - 1, d + days, 12)
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

/** ISO с локальным смещением: 2026-07-17T22:14:03+03:00 */
export function isoLocal(t: Date = new Date()): string {
  const off = -t.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

/** YYYY-MM месяца учебного дня — для имени файла журнала */
export function monthOfDay(day: string): string {
  return day.slice(0, 7)
}
