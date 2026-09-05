/**
 * Тесты чистых функций журнала (src/lib/journal.ts), без React/IndexedDB.
 *
 * Закрывают дефект A7: показ окна знакомства (type 'review', format 'intro',
 * пишет markIntroduced) не даёт рейтинга и не должен считаться упражнением.
 * reviewsByDay обязан считать оценённые строки (isGraded), а не все строки
 * type 'review' подряд, иначе полоса нормы дня, пол RUN_MIN_REVIEWS и серия
 * дней засчитывают показ знакомства как упражнение.
 *
 * Запуск: `npm run test:journal` (esbuild бандлит файл и node его исполняет).
 */
import type { JournalLine } from '../src/lib/types'
import { isGraded, reviewsByDay, isDayDone, minutesByDay, emptyDays, floorDays, RUN_MIN_REVIEWS } from '../src/lib/journal'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

const DAY = '2026-09-01'

const gradedLine = (rating = 3, o: Partial<JournalLine> = {}): JournalLine => ({
  id: Math.random().toString(36).slice(2), type: 'review', ts: `${DAY}T10:00:00+03:00`,
  day: DAY, format: 'reveal', rating, ...o
})

const introLine = (o: Partial<JournalLine> = {}): JournalLine => ({
  id: Math.random().toString(36).slice(2), type: 'review', ts: `${DAY}T09:00:00+03:00`,
  day: DAY, format: 'intro', ...o
})

// ---- isGraded / reviewsByDay ----------------------------------------------

function reviewsByDayChecks(): void {
  const lines: JournalLine[] = []
  for (let i = 0; i < 12; i++) lines.push(introLine())
  for (let i = 0; i < 3; i++) lines.push(gradedLine())

  const byDay = reviewsByDay(lines)
  assert(byDay.get(DAY) === 3, `reviewsByDay должен считать только оценённые строки: ожидалось 3, получено ${byDay.get(DAY)}`)
  group('reviewsByDay: 12 показов знакомства без рейтинга не считаются, 3 оценённые строки дают 3')

  // «уже знаю» на окне знакомства: format 'intro' с рейтингом, это оценка, она засчитывается
  const withKnownAlready = [...lines, introLine({ rating: 4 })]
  const byDay2 = reviewsByDay(withKnownAlready)
  assert(byDay2.get(DAY) === 4, `intro-строка с рейтингом («уже знаю») обязана считаться оценкой: ожидалось 4, получено ${byDay2.get(DAY)}`)
  group('reviewsByDay: format intro с рейтингом («уже знаю») считается оценкой')

  assert(!isGraded(introLine()), 'intro без rating не должен быть оценкой')
  assert(isGraded(introLine({ rating: 4 })), 'intro с rating обязан быть оценкой')
  assert(isGraded(gradedLine()), 'обычная оценённая строка обязана быть оценкой')
  assert(!isGraded({ id: 'x', ts: DAY, day: DAY, type: 'session' } as JournalLine), 'строка не review не может быть оценкой')
  group('isGraded: правило type review + числовой rating')
}

// ---- isDayDone --------------------------------------------------------------

function isDayDoneChecks(): void {
  const graded12: JournalLine[] = []
  for (let i = 0; i < 12; i++) graded12.push(gradedLine())
  const minutes = minutesByDay(graded12)
  const empty = emptyDays(graded12)
  const reviews12 = reviewsByDay(graded12)
  assert(isDayDone(DAY, minutes, empty, reviews12) === true, '12 оценённых строк обязаны закрывать день полом RUN_MIN_REVIEWS')
  group(`isDayDone: 12 оценённых строк (порог ${RUN_MIN_REVIEWS}) закрывают день`)

  const mixed: JournalLine[] = []
  for (let i = 0; i < 11; i++) mixed.push(gradedLine())
  for (let i = 0; i < 5; i++) mixed.push(introLine())
  const minutesMixed = minutesByDay(mixed)
  const emptyMixed = emptyDays(mixed)
  const reviewsMixed = reviewsByDay(mixed)
  assert(reviewsMixed.get(DAY) === 11, `в смешанном наборе оценок должно быть 11, получено ${reviewsMixed.get(DAY)}`)
  assert(isDayDone(DAY, minutesMixed, emptyMixed, reviewsMixed) === false, '11 оценок и 5 показов знакомства не должны закрывать день: показов знакомства не хватает до пола')
  group('isDayDone: 11 оценённых строк плюс 5 показов знакомства дня не закрывают (RUN_MIN_REVIEWS не набран)')
}

// ---- floorDays --------------------------------------------------------------

function floorDaysChecks(): void {
  const introOnly: JournalLine[] = []
  for (let i = 0; i < 20; i++) introOnly.push(introLine())
  const { done } = floorDays(introOnly, DAY, 1)
  assert(done === 0, `день с одними показами знакомства не должен входить в floorDays: ожидалось 0, получено ${done}`)
  group('floorDays: день с одними intro-строками (без оценок) не входит в done')
}

function main(): void {
  console.log('SRS journal: reviewsByDay/isGraded/isDayDone/floorDays (A7: показ знакомства не упражнение)')
  reviewsByDayChecks()
  isDayDoneChecks()
  floorDaysChecks()
  console.log(`\nВсе проверки журнала пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ ЖУРНАЛА УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
