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
import {
  isGraded, reviewsByDay, isDayDone, minutesByDay, emptyDays, floorDays, RUN_MIN_REVIEWS,
  dayUnitsByDay, practiceUnitsByDay, practiceMinutesByDay, PRACTICE_UNIT_RATIO_FLOOR,
  readTextsToday, READ_MIN_TEXTS, stemEn, deckHasWord, markDigest, readingSrc
} from '../src/lib/journal'

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

// ---- D5: зачёт дня по трём каналам (практика в единицах) --------------------

const practiceLine = (sec: number, o: Partial<JournalLine> = {}): JournalLine => ({
  id: Math.random().toString(36).slice(2), type: 'practice', ts: `${DAY}T11:00:00+03:00`,
  day: DAY, qid: 'q1', sec, ...o
})

function dayUnitsChecks(): void {
  const RATIO = 8

  // 4 строки practice (sec 60-90) и 1 оценённая review при ratio 8: units >= 12, isDayDone true
  const withReview: JournalLine[] = [
    practiceLine(60), practiceLine(70), practiceLine(80), practiceLine(90),
    gradedLine()
  ]
  const minutes1 = minutesByDay(withReview)
  const empty1 = emptyDays(withReview)
  const units1 = dayUnitsByDay(withReview, RATIO)
  const reviews1 = reviewsByDay(withReview)
  assert((units1.get(DAY) ?? 0) >= RUN_MIN_REVIEWS, `units обязаны набрать порог RUN_MIN_REVIEWS: получено ${units1.get(DAY)}`)
  assert(isDayDone(DAY, minutes1, empty1, units1, reviews1) === true,
    'день с 4 строками практики и 1 оценённой review обязан закрываться при ratio 8')
  group('dayUnitsByDay/isDayDone: 4 строки practice + 1 review при ratio 8 закрывают день')

  // тот же день, но без единой review - практика одна день не закрывает
  const withoutReview = withReview.filter(l => l.type !== 'review')
  const minutes2 = minutesByDay(withoutReview)
  const empty2 = emptyDays(withoutReview)
  const units2 = dayUnitsByDay(withoutReview, RATIO)
  const reviews2 = reviewsByDay(withoutReview)
  assert((units2.get(DAY) ?? 0) >= RUN_MIN_REVIEWS, `практика одна тоже обязана набрать units: получено ${units2.get(DAY)}`)
  assert(isDayDone(DAY, minutes2, empty2, units2, reviews2) === false,
    'день без единой оценённой карточки не должен закрываться одной практикой, сколько бы единиц она ни дала')
  group('dayUnitsByDay/isDayDone: та же практика без единой review день НЕ закрывает')

  // день с 12 оценками - закрыт, как и раньше (существующая проверка A7 остаётся зелёной)
  const graded12: JournalLine[] = []
  for (let i = 0; i < 12; i++) graded12.push(gradedLine())
  const minutes3 = minutesByDay(graded12)
  const empty3 = emptyDays(graded12)
  const units3 = dayUnitsByDay(graded12, RATIO)
  const reviews3 = reviewsByDay(graded12)
  assert(isDayDone(DAY, minutes3, empty3, units3, reviews3) === true, '12 оценок карточек обязаны закрывать день, как и раньше')
  group('dayUnitsByDay/isDayDone: день с 12 оценками карточек закрыт, как и раньше')

  // practiceUnitsByDay/practiceMinutesByDay сами по себе
  const pu = practiceUnitsByDay(withReview, RATIO)
  assert(pu.get(DAY) === RATIO * 4, `practiceUnitsByDay обязан дать 4 * ratio: ожидалось ${RATIO * 4}, получено ${pu.get(DAY)}`)
  const pm = practiceMinutesByDay(withReview)
  const expectedMin = (60 + 70 + 80 + 90) / 60
  assert(Math.abs((pm.get(DAY) ?? 0) - expectedMin) < 1e-9, `practiceMinutesByDay обязан суммировать sec/60: ожидалось ${expectedMin}, получено ${pm.get(DAY)}`)
  group('practiceUnitsByDay/practiceMinutesByDay: считают только строки type practice')

  assert(PRACTICE_UNIT_RATIO_FLOOR > 0, 'пол коэффициента практики обязан быть положительным')
  group('PRACTICE_UNIT_RATIO_FLOOR: положительная константа-пол')
}

// ---- D6: чтение засчитывается текстами, а не минутами ------------------------

const readingLine = (slug: string, o: Partial<JournalLine> = {}): JournalLine => ({
  id: Math.random().toString(36).slice(2), type: 'reading', ts: `${DAY}T12:00:00+03:00`,
  day: DAY, slug, ...o
})

function readTextsTodayChecks(): void {
  assert(READ_MIN_TEXTS === 1, 'норма чтения обязана быть достижимой единицей (1 текст/день)')
  group('READ_MIN_TEXTS: норма чтения задана текстами, а не минутами')

  // одна и та же лемма/текст, прочитанная дважды за день, - один текст, не два
  const oneTextTwice = [readingLine('slug-a', { read_s: 200 }), readingLine('slug-a', { read_s: 210 })]
  assert(readTextsToday(oneTextTwice, DAY) === 1, 'повторное прочтение того же текста не должно давать вторую единицу')
  group('readTextsToday: два прочтения одного текста дают 1')

  const twoTexts = [readingLine('slug-a'), readingLine('slug-b')]
  assert(readTextsToday(twoTexts, DAY) === 2, 'два разных текста за день обязаны дать 2')
  group('readTextsToday: два разных текста за день дают 2')

  const otherDay = [readingLine('slug-a', { day: '2026-09-02' })]
  assert(readTextsToday(otherDay, DAY) === 0, 'прочтение другого учебного дня не должно засчитываться сегодня')
  group('readTextsToday: прочтение другого дня не считается за сегодня')
}

// ---- stemEn / deckHasWord / markDigest (F41) ------------------------------

function stemEnChecks(): void {
  // формы, отмеченные в тексте, обязаны сойтись основой со словом карточки колоды
  const pairs: [string, string][] = [
    ['assumptions', 'assumption'],
    ['distinctive', 'distinct'],
    ['praised', 'praise'],
    ["treaty's", 'treaty'],
    ['depletion', 'deplete'],
    ['cited', 'cite'],
    ['citing', 'cite']
  ]
  for (const [form, base] of pairs) {
    assert(stemEn(form) === stemEn(base), `stemEn(${form})=${stemEn(form)} обязан совпасть с stemEn(${base})=${stemEn(base)}`)
  }
  // разные слова не обязаны схлопываться в одну основу
  const distinctPairs: [string, string][] = [
    ['arbitrary', 'justify'], ['cite', 'city'], ['deplete', 'delete'], ['assumption', 'assume']
  ]
  for (const [a, b] of distinctPairs) {
    assert(stemEn(a) !== stemEn(b), `stemEn(${a}) и stemEn(${b}) не должны совпасть, оба дали ${stemEn(a)}`)
  }
  group('stemEn: формы слова из живой находки F41 сходятся основой, посторонние слова не схлопываются')
}

function deckHasWordChecks(): void {
  const deck = new Set(['assumption', 'praise', 'treaty', 'deplete', 'cite'])
  assert(deckHasWord(deck, 'assumptions'), 'assumptions обязано найтись в колоде через основу assumption')
  assert(deckHasWord(deck, 'praised'), 'praised обязано найтись в колоде через основу praise')
  assert(deckHasWord(deck, "treaty's"), "treaty's обязано найтись в колоде через основу treaty")
  assert(deckHasWord(deck, 'depletion'), 'depletion обязано найтись в колоде через основу deplete')
  assert(deckHasWord(deck, 'cited', 'citing'), 'cited/citing обязаны найтись в колоде через основу cite')
  assert(!deckHasWord(deck, 'bolster'), 'слово, которого в колоде нет ни в одной форме, не должно находиться')
  group('deckHasWord: сравнение по основе находит формы слов колоды (F41), посторонние слова остаются не найдены')
}

function markDigestChecks(): void {
  const deck = new Set(['assumption'])
  const lines: JournalLine[] = [
    { id: 'm1', type: 'mark', ts: `${DAY}T11:00:00+03:00`, day: DAY, src: readingSrc('t1'), word: 'assumptions', lemma: 'assumptions', sentence: 'Some assumptions were wrong.', on: true } as JournalLine
  ]
  const md = markDigest(lines, deck)
  assert(md.entries.length === 1 && md.entries[0].inDeck === true,
    `отметка формы assumptions при карточке assumption обязана дать inDeck=true, получено ${JSON.stringify(md.entries)}`)
  group('markDigest: отметка формы слова с уже заведённой карточкой не уезжает в кандидаты (F41)')
}

function main(): void {
  console.log('SRS journal: reviewsByDay/isGraded/isDayDone/floorDays (A7: показ знакомства не упражнение)')
  reviewsByDayChecks()
  isDayDoneChecks()
  floorDaysChecks()
  dayUnitsChecks()
  readTextsTodayChecks()
  stemEnChecks()
  deckHasWordChecks()
  markDigestChecks()
  console.log(`\nВсе проверки журнала пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ ЖУРНАЛА УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
