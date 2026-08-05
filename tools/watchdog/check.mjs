#!/usr/bin/env node
/**
 * Сторож занятий. Запускается в GitHub Actions ТОГО репозитория, где лежит
 * журнал ревью, и отвечает на единственный вопрос: занимался ли человек сегодня.
 *
 * Зачем он вообще есть. В приложении нет ни одного уведомления (grep по
 * `Notification` / `requestPermission` / `periodicsync` — пусто), а
 * `setAppBadge` на iOS без разрешения на уведомления молча не работает. То есть
 * при закрытом приложении система не могла позвать обратно НИЧЕМ. Простой с
 * 01.08 по 05.08 не заметил никто, включая сам инструмент: журнал фиксирует
 * только действия и никогда — отсутствие.
 *
 * Что он делает:
 *   1. считает упражнения за текущий учебный день (граница 04:00 по Еревану);
 *   2. если их меньше пола — дописывает строку отсутствия в СВОЙ файл;
 *   3. печатает JSON для шага, который обновляет одну скользящую заявку.
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

/** Граница учебного дня и домашний пояс — как в приложении. */
const DAY_ROLLOVER_HOUR = 4
const HOME_OFFSET_MIN = 240 // Ереван, UTC+4

const EXAM = Date.UTC(2026, 9, 3) // 03.10.2026, основная попытка

/** Учебный день по домашнему поясу с переносом границы на 04:00. */
export function studyDay(now = new Date()) {
  const shifted = new Date(now.getTime() + HOME_OFFSET_MIN * 60_000 - DAY_ROLLOVER_HOUR * 3600_000)
  return shifted.toISOString().slice(0, 10)
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

async function main() {
  const dir = process.argv[2] ?? 'Учёба/Карточки/_журнал'
  const now = new Date()
  const day = studyDay(now)
  const reviews = countReviews(await readJournal(dir), day)
  const missed = reviews < RUN_MIN_REVIEWS
  const left = daysToExam(now)

  if (missed) {
    // Отдельный файл — единственный писатель здесь этот скрипт (см. шапку).
    await mkdir(dir, { recursive: true })
    const absencePath = path.join(dir, '_отсутствие.ndjson')
    const prev = existsSync(absencePath) ? await readFile(absencePath, 'utf8') : ''
    if (!prev.includes(`"day":"${day}"`)) { // идемпотентность: повторный прогон не плодит строк
      const line = JSON.stringify({ v: 1, type: 'absence', day, reviews, floor: RUN_MIN_REVIEWS, days_to_exam: left, ts: now.toISOString() })
      await writeFile(absencePath, prev + (prev.endsWith('\n') || !prev ? '' : '\n') + line + '\n', 'utf8')
    }
  }

  const result = { day, reviews, floor: RUN_MIN_REVIEWS, missed, daysToExam: left }
  console.log(JSON.stringify(result))
  if (process.env.GITHUB_OUTPUT) {
    const kv = Object.entries(result).map(([k, v]) => `${k}=${v}`).join('\n')
    await writeFile(process.env.GITHUB_OUTPUT, kv + '\n', { flag: 'a' })
  }
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') || process.argv[1]?.endsWith('check.mjs')) {
  main().catch(e => { console.error(e); process.exit(1) })
}
