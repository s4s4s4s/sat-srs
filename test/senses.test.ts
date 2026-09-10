/**
 * Тесты ротации значений слова (src/lib/senses.ts, T5), без React/IndexedDB.
 *
 * Карточка учит одно главное значение, а остальные - other_senses - на экзамене тоже могут
 * спросить, если тьютор завёл им примеры-предложения (contexts/contextsRu значения). chooseSense
 * держит ротацию: провал спрашивается снова, иначе - первый непройденный слот, а когда все
 * пройдены - по кругу. Правило C17 колоды.
 *
 * Запуск: `npm run test:senses` (esbuild бандлит файл и node его исполняет).
 */
import { createEmptyCard } from 'ts-fsrs'
import type { CardView, JournalLine, Sense } from '../src/lib/types'
import { senseSlots, senseSlot, senseHistory, chooseSense, pickSense, ctxKey, senseDisplay } from '../src/lib/senses'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

const DAY = '2026-09-10'
const BASE = new Date(`${DAY}T10:00:00+04:00`)

function sense(idx: number, o: Partial<Sense> = {}): Sense {
  return { pos: 'noun', en: `sense ${idx} en`, ru: `sense ${idx} ru`, contexts: [`ctx ${idx}`], contextsRu: [], ...o }
}

/** CardView с несколькими other_senses, у которых есть контексты (значит слоты 1..n живые). */
function makeCard(o: Partial<CardView> = {}): CardView {
  return {
    path: 'deck/assay.md', slug: 'assay', word: 'assay', pos: 'noun',
    context: 'main ctx', contexts: ['main ctx'], contextsRu: [],
    meaning_en: 'main en', meaning_ru: 'main ru', roots: '',
    source: 'test', added: '2026-01-01', level: 1, kind: 'vocab', domain: '',
    confusables: [], synonyms: [], other_senses: [], from_mark: [], leech: '',
    choices: [], answerText: '', answerNum: '',
    desmos: false, explain: '', suspended: false,
    fsrs: createEmptyCard(BASE),
    prep: '', prepContext: '', fsrsPrep: null,
    ...o
  }
}

const reviewLine = (slug: string, o: Partial<JournalLine> = {}): JournalLine => ({
  id: Math.random().toString(36).slice(2), type: 'review', ts: `${DAY}T10:00:00+04:00`,
  day: DAY, format: 'reveal', rating: 3, slug, ...o
})

// ---- senseSlots / senseSlot ---------------------------------------------------

function senseSlotsChecks(): void {
  const noOther = makeCard()
  assert(senseSlots(noOther).length === 1 && senseSlots(noOther)[0].idx === 0,
    'без other_senses слот только один - главное значение (idx 0)')
  group('senseSlots: без other_senses даёт один слот - главное значение')

  const withMixed = makeCard({
    other_senses: [sense(1), sense(2, { contexts: [] }), sense(3)]
  })
  const slots = senseSlots(withMixed)
  assert(slots.length === 3, 'значение без контекстов (sense 2) обязано выпасть из слотов')
  assert(JSON.stringify(slots.map(s => s.idx)) === JSON.stringify([0, 1, 3]),
    'слоты обязаны остаться главным (0) плюс only те other_senses, у которых есть контексты (1 и 3, не 2)')
  group('senseSlots: пропускает значения без контекстов')

  const outOfRange = senseSlot(withMixed, 99)
  assert(outOfRange.idx === 0, 'senseSlot вне диапазона обязан вернуть главное значение')
  group('senseSlot: индекс вне диапазона - главное значение')

  const withoutContexts = senseSlot(withMixed, 2)
  assert(withoutContexts.idx === 0, 'senseSlot на значение без контекстов обязан вернуть главное значение')
  group('senseSlot: значение без контекстов - главное значение')

  const found = senseSlot(withMixed, 3)
  assert(found.idx === 3 && found.ru === 'sense 3 ru', 'senseSlot по валидному индексу обязан вернуть сам слот')
  group('senseSlot: валидный индекс возвращает сам слот')
}

// ---- senseHistory ---------------------------------------------------------

function senseHistoryChecks(): void {
  const journal: JournalLine[] = [
    reviewLine('assay', { format: 'intro', rating: undefined, sense: 5 }),
    reviewLine('assay', { format: 'prep', sense: 7 }),
    reviewLine('assay', { format: 'reveal', rating: 3 }), // без sense - главное (0)
    reviewLine('assay', { format: 'mc', rating: 1, sense: 2 }),
    reviewLine('assay', { format: 'type', rating: 3, gave_up: true, sense: 1 }),
    reviewLine('other-word', { format: 'mc', rating: 3, sense: 1 }), // чужое слово
    { id: 'x', type: 'session', ts: `${DAY}T10:00:00+04:00`, day: DAY } as JournalLine // не review
  ]
  const hist = senseHistory(journal, 'assay')
  assert(hist.length === 3, `intro/prep и чужое слово обязаны выпасть из истории, получено ${hist.length} строк`)
  assert(hist[0].sense === 0 && hist[0].failed === false, 'строка без sense читается как главное значение (0), rating 3 - не провал')
  assert(hist[1].sense === 2 && hist[1].failed === true, 'rating 1 (Again) - провал')
  assert(hist[2].sense === 1 && hist[2].failed === true, 'gave_up - тоже провал, даже если rating не Again')
  group('senseHistory: игнорирует intro/prep и чужие строки, gave_up считается провалом, строка без sense - главное значение')
}

// ---- chooseSense (ядро) ----------------------------------------------------

function chooseSenseChecks(): void {
  assert(chooseSense([], []) === 0, 'пустой список слотов - 0')
  group('chooseSense: пустой список слотов - 0')

  assert(chooseSense([0], [{ sense: 0, failed: true }]) === 0, 'один слот - всегда 0, даже после провала')
  group('chooseSense: один слот - 0')

  const afterAgain = chooseSense([0, 1, 2], [{ sense: 1, failed: true }])
  assert(afterAgain === 1, 'после провала на значении 1 следующий показ обязан спросить то же значение')
  group('chooseSense: после провала (Again) - то же значение')

  const afterGood = chooseSense([0, 1, 2], [{ sense: 0, failed: false }])
  assert(afterGood === 1, 'после успеха на главном (0) следующий показ обязан взять первый непройденный - 1')
  group('chooseSense: после успеха - следующее непройденное значение')

  const allDone = chooseSense([0, 1, 2], [
    { sense: 0, failed: false }, { sense: 1, failed: false }, { sense: 2, failed: false }
  ])
  assert(allDone === 0, 'все слоты пройдены успешно - ротация идёт по кругу от последнего (2) к первому (0)')
  group('chooseSense: все слоты отработаны - по кругу')

  const vanished = chooseSense([0, 1], [{ sense: 5, failed: true }])
  assert(vanished === 0, 'провалившееся значение (5) исчезло из текущих слотов - откат на главное (0)')
  group('chooseSense: провалившееся значение исчезло из слотов - 0')
}

// ---- pickSense --------------------------------------------------------------

function pickSenseChecks(): void {
  const card = makeCard({ other_senses: [sense(1), sense(2)] })
  const journal: JournalLine[] = [reviewLine('assay', { format: 'mc', rating: 3, sense: 0 })]

  assert(pickSense(card, journal, 'intro', 'sentence') === 0, 'intro всегда спрашивает главное значение')
  assert(pickSense(card, journal, 'prep', 'sentence') === 0, 'prep всегда спрашивает главное значение')
  assert(pickSense(card, journal, 'mc', 'word') === 0, 'cue word (само слово на экране) всегда спрашивает главное значение')
  group('pickSense: intro/prep/cue word всегда 0')

  const next = pickSense(card, journal, 'mc', 'meaning')
  assert(next === 1, 'обычный показ (не intro/prep/word) обязан ротировать по chooseSense - следующее непройденное значение')
  group('pickSense: обычный показ ротирует значение по chooseSense')
}

// ---- ctxKey -------------------------------------------------------------

function ctxKeyChecks(): void {
  const path = 'deck/assay.md'
  assert(ctxKey(path, 0) === path, 'ctxKey(path, 0) обязан совпасть с самим путём - старые ключи ротации контекстов остаются валидными')
  assert(ctxKey(path, 1) === `${path}#1`, 'ctxKey(path, idx>0) обязан отличаться от пути, чтобы не делить счётчик с главным значением')
  assert(ctxKey(path, 1) !== ctxKey(path, 2), 'разные значения обязаны иметь разные ключи ротации контекста')
  group('ctxKey: idx 0 совпадает с путём, idx>0 - свой ключ')
}

// ---- senseDisplay ---------------------------------------------------------

function senseDisplayChecks(): void {
  const card = makeCard({ other_senses: [sense(1), sense(2)] })
  const { asked, rest } = senseDisplay(card, 2)
  assert(asked.idx === 2, 'asked обязан быть проверенным значением')
  assert(rest.length === 2 && rest[0].idx === 0 && rest[1].idx === 1,
    'rest обязан содержать остальные значения в порядке индексов, включая главное (0), раз спрашивали не его')
  group('senseDisplay: idx 2 кладёт главное значение в rest вместе с остальными, по порядку индексов')

  const displayMain = senseDisplay(card, 0)
  assert(displayMain.asked.idx === 0 && displayMain.rest.length === 2
    && displayMain.rest[0].idx === 1 && displayMain.rest[1].idx === 2,
    'при спрошенном главном значении rest обязан содержать остальные слоты по порядку индексов')
  group('senseDisplay: спрошено главное значение - rest содержит остальные слоты')

  // значение без контекстов не входит в senseSlots (спросить его нельзя), но после ответа
  // список "Ещё значения" обязан показать его тоже - ученику нужны все значения слова, а не
  // только те, что годятся для ротации показа
  const withGap = makeCard({ other_senses: [sense(1), sense(2, { contexts: [] }), sense(3)] })
  const displayWithGap = senseDisplay(withGap, 0)
  assert(displayWithGap.rest.length === 3 && displayWithGap.rest.map(s => s.idx).join(',') === '1,2,3',
    'rest обязан включать значение без контекстов (idx 2) наравне с остальными')
  const gapSlot = displayWithGap.rest.find(s => s.idx === 2)
  assert(!!gapSlot && gapSlot.contexts.length === 0 && gapSlot.ru === 'sense 2 ru',
    'значение без контекстов в rest обязано сохранить свои поля (ru, contexts пустой)')
  group('senseDisplay: значение без контекстов попадает в rest')
}

function main(): void {
  console.log('SRS senses: ротация значений слова (T5, правило C17)')
  senseSlotsChecks()
  senseHistoryChecks()
  chooseSenseChecks()
  pickSenseChecks()
  ctxKeyChecks()
  senseDisplayChecks()
  console.log(`\nВсе проверки ротации значений пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ РОТАЦИИ ЗНАЧЕНИЙ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
