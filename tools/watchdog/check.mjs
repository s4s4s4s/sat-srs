#!/usr/bin/env node
/**
 * Сторож занятий. Запускается в GitHub Actions ТОГО репозитория, где лежит
 * журнал ревью, и отвечает на два РАЗНЫХ вопроса про два разных дня:
 *   - занимается ли человек СЕГОДНЯ — учебный день ещё открыт до 04:00
 *     следующих суток, это повод напомнить, а не повод писать данные;
 *   - закрыл ли пол ВЧЕРАШНИЙ, уже завершившийся учебный день — единственный
 *     повод дописать строку в датасет отсутствий.
 *
 * Зачем он вообще есть. В приложении нет ни одного уведомления (grep по
 * `Notification` / `requestPermission` / `periodicsync` — пусто), а
 * `setAppBadge` на iOS без разрешения на уведомления молча не работает. То есть
 * при закрытом приложении система не могла позвать обратно НИЧЕМ. Простой с
 * 01.08 по 05.08 не заметил никто, включая сам инструмент: журнал фиксирует
 * только действия и никогда — отсутствие.
 *
 * Что он делает:
 *   1. считает упражнения за текущий, ещё НЕ закрытый учебный день (граница
 *      04:00 по Еревану, см. studyDay()) — только для заявки-напоминания;
 *   2. отдельно считает упражнения за ПРЕДЫДУЩИЙ, уже закрытый учебный день
 *      (см. closedStudyDay()) — если их меньше пола, дописывает строку
 *      отсутствия в СВОЙ файл;
 *   3. печатает JSON для шагов, которые обновляют одну скользящую заявку и
 *      коммитят строку отсутствия.
 *
 * Почему нельзя писать отсутствие за текущий день: он кончается в 04:00
 * следующих суток, а прогон идёт в 19:00 — часы на то, чтобы закрыть пол, ещё
 * остаются. Строка, записанная в 19:00 про ещё не закрытый день, приговаривает
 * его раньше срока: 16.08.2026 такую строку дважды убирали руками, и она
 * возвращалась, потому что писалась не за тот день.
 *
 * Почему отсутствие пишется в отдельный файл, а не в месячный журнал:
 * месячный файл приложение пересобирает ЦЕЛИКОМ при каждом пуше
 * (`src/lib/sync.ts`), и дописанная снаружи строка была бы затёрта первым же
 * занятием. У каждого файла ровно один писатель — здесь это правило и работает.
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** Пол дня: столько упражнений держит серию. Держать синхронно с
 *  `RUN_MIN_REVIEWS` в src/lib/journal.ts. */
const RUN_MIN_REVIEWS = 12

/** Граница учебного дня и домашний пояс — как в src/lib/daytime.ts
 *  (ROLLOVER_H и homeOffsetMin=240 для Еревана). */
const DAY_ROLLOVER_HOUR = 4
const HOME_OFFSET_MIN = 240 // Ереван, UTC+4
const MS_PER_DAY = 86_400_000

const EXAM = Date.UTC(2026, 9, 3) // 03.10.2026, основная попытка

/** Учебный день по домашнему поясу с переносом границы на 04:00. Совпадает
 *  с dayKey() из src/lib/daytime.ts при homeOffsetMin=240. */
export function studyDay(now = new Date()) {
  const shifted = new Date(now.getTime() + HOME_OFFSET_MIN * 60_000 - DAY_ROLLOVER_HOUR * 3600_000)
  return shifted.toISOString().slice(0, 10)
}

/** Последний уже ЗАКРЫТЫЙ учебный день на момент now — тот, что кончился на
 *  ближайшей в прошлом границе 04:00. Вычислен через ту же studyDay() на
 *  сутки раньше, а не вычитанием даты из строки: так результат не зависит от
 *  случайного числового совпадения HOME_OFFSET_MIN и DAY_ROLLOVER_HOUR*60. */
export function closedStudyDay(now = new Date()) {
  return studyDay(new Date(now.getTime() - MS_PER_DAY))
}

export function daysToExam(now = new Date()) {
  return Math.max(0, Math.ceil((EXAM - now.getTime()) / 86_400_000))
}

/** Сколько упражнений в журнале за указанный учебный день. */
export function countReviews(lines, day) {
  let n = 0
  for (const raw of lines) {
    const s = raw.trim()
    if (!s) continue
    let l
    try { l = JSON.parse(s) } catch { continue } // битую строку пропускаем молча — она не наша забота
    if (l.type === 'review' && l.day === day) n++
  }
  return n
}

async function readJournal(dir) {
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter(f => /^\d{4}-\d{2}\.ndjson$/.test(f)).sort()
  const out = []
  for (const f of files) out.push(...(await readFile(path.join(dir, f), 'utf8')).split('\n'))
  return out
}

/** Явная точка подмены времени для прогонов и проверок:
 *  `WATCHDOG_NOW=2026-08-16T15:00:00Z node check.mjs`. Не глобальный хак
 *  поверх Date — обычное значение, прочитанное один раз на входе и дальше
 *  передаваемое параметром во все чистые функции ниже. */
function readNow() {
  return process.env.WATCHDOG_NOW ? new Date(process.env.WATCHDOG_NOW) : new Date()
}

export async function main(dir = process.argv[2] ?? 'Учёба/Карточки/_журнал', now = readNow()) {
  const today = studyDay(now)
  const prevDay = closedStudyDay(now)
  const lines = await readJournal(dir)

  // Сегодняшний, ещё НЕ закрытый день — только для заявки-напоминания.
  const todayReviews = countReviews(lines, today)
  const missed = todayReviews < RUN_MIN_REVIEWS

  // Вчерашний, уже закрытый день — единственный повод для записи в датасет.
  const prevReviews = countReviews(lines, prevDay)
  const prevMissed = prevReviews < RUN_MIN_REVIEWS

  const left = daysToExam(now)

  if (prevMissed) {
    // Отдельный файл — единственный писатель здесь этот скрипт (см. шапку).
    await mkdir(dir, { recursive: true })
    const absencePath = path.join(dir, '_отсутствие.ndjson')
    const prevContent = existsSync(absencePath) ? await readFile(absencePath, 'utf8') : ''
    if (!prevContent.includes(`"day":"${prevDay}"`)) { // идемпотентность: повторный прогон не плодит строк
      const line = JSON.stringify({ v: 1, type: 'absence', day: prevDay, reviews: prevReviews, floor: RUN_MIN_REVIEWS, days_to_exam: left, ts: now.toISOString() })
      await writeFile(absencePath, prevContent + (prevContent.endsWith('\n') || !prevContent ? '' : '\n') + line + '\n', 'utf8')
    }
  }

  // day/reviews/missed — про СЕГОДНЯ, для заявки-напоминания (шаги open/close
  // issue в srs-watchdog.yml). prevDay/prevReviews/prevMissed — про ВЧЕРА, для
  // шага commit absence line. Смешивать эти пары нельзя — в этом и была ошибка.
  const result = { day: today, reviews: todayReviews, floor: RUN_MIN_REVIEWS, missed, daysToExam: left, prevDay, prevReviews, prevMissed }
  console.log(JSON.stringify(result))
  if (process.env.GITHUB_OUTPUT) {
    const kv = Object.entries(result).map(([k, v]) => `${k}=${v}`).join('\n')
    await writeFile(process.env.GITHUB_OUTPUT, kv + '\n', { flag: 'a' })
  }
  return result
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') || process.argv[1]?.endsWith('check.mjs')) {
  main().catch(e => { console.error(e); process.exit(1) })
}
