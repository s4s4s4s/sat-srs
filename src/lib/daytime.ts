/**
 * Логика «учебного дня»: граница в 04:00 (занятия за полночь не ломают серию и лимиты).
 * Пояс: по умолчанию — часы устройства; через setHomeOffset можно закрепить домашний пояс
 * (минуты от UTC) — тогда все устройства и кривые часы ПК считают день одинаково.
 */

export const ROLLOVER_H = 4

let homeOffsetMin: number | null = null

/** Закрепить домашний пояс (минуты от UTC, напр. 180 = Москва, 240 = Ереван); null = часы устройства */
export function setHomeOffset(min: number | null) {
  homeOffsetMin = Number.isFinite(min as number) ? min : null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** YYYY-MM-DD локального учебного дня для момента t */
export function dayKey(t: Date = new Date()): string {
  if (homeOffsetMin !== null) {
    const d = new Date(t.getTime() + homeOffsetMin * 60_000 - ROLLOVER_H * 3600_000)
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  }
  const d = new Date(t.getTime() - ROLLOVER_H * 3600_000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Конец текущего учебного дня (следующие 04:00 домашнего времени) */
export function endOfStudyDay(t: Date = new Date()): Date {
  if (homeOffsetMin !== null) {
    const h = new Date(t.getTime() + homeOffsetMin * 60_000)
    let base = Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate(), ROLLOVER_H, 0, 0)
    if (h.getUTCHours() >= ROLLOVER_H) base += 86400_000
    return new Date(base - homeOffsetMin * 60_000)
  }
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

/** ISO со смещением домашнего пояса (или пояса устройства): 2026-07-18T22:14:03+03:00 */
export function isoLocal(t: Date = new Date()): string {
  const off = homeOffsetMin !== null ? homeOffsetMin : -t.getTimezoneOffset()
  const d = new Date(t.getTime() + off * 60_000)
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

/** YYYY-MM месяца учебного дня — для имени файла журнала */
export function monthOfDay(day: string): string {
  return day.slice(0, 7)
}
