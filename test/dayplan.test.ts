/**
 * Тесты плана дня (src/lib/dayplan.ts), без React/IndexedDB.
 *
 * Закрывают дефект: 94% оценок уходили в словарь, разделы SEC (грамматика) и EOI
 * (логика) - ноль оценок за три месяца. `kindRank` в scheduler.ts ставит грамматику
 * вперёд, но `freshItems` работает ВНУТРИ раздела, а не между ними, поэтому
 * приоритет между разделами никогда не срабатывал. `sectionDebt`/`nextSection`
 * считают долг раздела перед весом Reading & Writing цифрового SAT и решают,
 * какой раздел предложить первым.
 *
 * Запуск: `npm run test:dayplan` (esbuild бандлит файл и node его исполняет).
 */
import { createEmptyCard } from 'ts-fsrs'
import type { CardView, JournalLine } from '../src/lib/types'
import { SECTIONS, type Section } from '../src/lib/scheduler'
import { RW_WEIGHTS, sectionDebt, nextSection, sectionOrder } from '../src/lib/dayplan'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

const DAY = '2026-09-06'
const BASE = new Date(`${DAY}T10:00:00+04:00`)

/** Карточка-заготовка: минимум полей CardView, различаемых по `kind`/`domain`. */
function makeCard(slug: string, kind: string, domain = '', o: Partial<CardView> = {}): CardView {
  return {
    path: `deck/${slug}.md`, slug, word: slug, pos: 'noun',
    context: `___ ${slug}`, contexts: [`___ ${slug}`], contextsRu: [],
    meaning_en: `meaning ${slug}`, meaning_ru: `${slug} по-русски`, roots: '',
    source: 'test', added: '2026-01-01', level: 1, kind, domain,
    confusables: [], synonyms: [], other_senses: [], from_mark: [], leech: '', choices: [], answerText: '', answerNum: '',
    desmos: false, explain: '', suspended: false,
    fsrs: createEmptyCard(BASE),
    prep: '', prepContext: '', fsrsPrep: null,
    ...o
  }
}

/** Карточка New - есть что вводить (даёт разделу `hasWork`). */
function newCard(slug: string, kind: string, domain = ''): CardView {
  return makeCard(slug, kind, domain)
}

/** Карточка, дозревшая до Review с далёким сроком - работы по ней сегодня нет. */
function futureCard(slug: string, kind: string, domain = ''): CardView {
  const c = newCard(slug, kind, domain)
  c.fsrs = { ...c.fsrs, state: 2 /* State.Review */, due: new Date(BASE.getTime() + 60 * 86400_000) } as CardView['fsrs']
  return c
}

const gradedLine = (slug: string, o: Partial<JournalLine> = {}): JournalLine => ({
  id: Math.random().toString(36).slice(2), type: 'review', ts: `${DAY}T10:00:00+04:00`,
  day: DAY, format: 'reveal', rating: 3, slug, ...o
})

// ---- DP1: раздел без оценок с непустой очередью выигрывает приоритет -----

function priorityWhenGrammarEmptyOfGrades(): void {
  const vocabCards: CardView[] = [futureCard('word-a', 'vocab'), futureCard('word-b', 'vocab')]
  const grammarCards: CardView[] = [newCard('rule-a', 'grammar', 'SEC')]
  const cards = [...vocabCards, ...grammarCards]

  const journal: JournalLine[] = []
  for (let i = 0; i < 100; i++) journal.push(gradedLine(i % 2 === 0 ? 'word-a' : 'word-b'))

  const next = nextSection(journal, cards, DAY)
  assert(next === 'grammar', `при 100 оценках словаря и 0 оценках грамматики с непустой очередью грамматики nextSection обязан быть 'grammar', получено '${next}'`)
  group('DP1: 100 оценок vocab и 0 grammar с непустой очередью грамматики - nextSection === grammar')
}

function zeroDebtWhenGrammarHasNoWork(): void {
  const vocabCards: CardView[] = [futureCard('word-a', 'vocab'), futureCard('word-b', 'vocab')]
  // грамматика есть в колоде, но всё уже закрыто до дальнего срока - вводить и повторять нечего
  const grammarCards: CardView[] = [futureCard('rule-a', 'grammar', 'SEC')]
  const cards = [...vocabCards, ...grammarCards]

  const journal: JournalLine[] = []
  for (let i = 0; i < 100; i++) journal.push(gradedLine(i % 2 === 0 ? 'word-a' : 'word-b'))

  const debt = sectionDebt(journal, cards, DAY)
  assert(debt.grammar === 0, `раздел без новых и без просроченных обязан иметь долг 0, получено ${debt.grammar}`)

  const next = nextSection(journal, cards, DAY)
  assert(next !== 'grammar', `при пустой (без работы) грамматике nextSection не должен быть 'grammar', получено '${next}'`)
  group('DP1: грамматика без новых и без просроченных - долг 0, nextSection не grammar')
}

// ---- сумма весов RW ---------------------------------------------------------

function weightsSumCheck(): void {
  const sumOn54 = (RW_WEIGHTS.rw + RW_WEIGHTS.logic + RW_WEIGHTS.grammar) * 54
  assert(Math.abs(sumOn54 - 51) <= 3, `сумма RW_WEIGHTS по rw/logic/grammar обязана быть около 51/54 (±3), получено ${sumOn54}/54`)
  assert(RW_WEIGHTS.math === 0, 'у математики веса RW нет - она отдельная секция экзамена')
  for (const s of SECTIONS) assert(RW_WEIGHTS[s] >= 0, `вес раздела ${s} не может быть отрицательным`)
  group('DP1: сумма RW_WEIGHTS по rw/logic/grammar ~= 51/54')
}

// ---- детерминированность ----------------------------------------------------

function determinismCheck(): void {
  const cards: CardView[] = [
    newCard('word-a', 'vocab'),
    newCard('rule-a', 'grammar', 'SEC'),
    newCard('para-a', 'error', 'II'),
    newCard('math-a', 'math', 'ALG')
  ]
  const journal: JournalLine[] = [gradedLine('word-a'), gradedLine('word-a'), gradedLine('rule-a')]

  const debt1 = sectionDebt(journal, cards, DAY)
  const debt2 = sectionDebt(journal, cards, DAY)
  assert(JSON.stringify(debt1) === JSON.stringify(debt2), 'sectionDebt обязан быть детерминирован при одинаковых входах')

  const next1 = nextSection(journal, cards, DAY)
  const next2 = nextSection(journal, cards, DAY)
  assert(next1 === next2, 'nextSection обязан быть детерминирован при одинаковых входах')

  const order1 = sectionOrder(journal, cards, DAY)
  const order2 = sectionOrder(journal, cards, DAY)
  assert(JSON.stringify(order1) === JSON.stringify(order2), 'sectionOrder обязан быть детерминирован при одинаковых входах')
  assert(order1[0] === next1, 'первый раздел sectionOrder обязан совпадать с nextSection')
  assert(new Set(order1).size === SECTIONS.length, 'sectionOrder обязан перечислить каждый раздел ровно один раз')

  group('DP1: sectionDebt/nextSection/sectionOrder детерминированы')
}

// ---- interleaving внутри раздела: правило B5 не нарушено самим модулем -----

function noMixingWithinLesson(): void {
  // dayplan.ts определяет только ПОРЯДОК РАЗДЕЛОВ дня, а не порядок карточек внутри
  // раздела - формирование урока (interleaving) остаётся заботой buildQueue/scheduler.ts.
  const cards: CardView[] = [newCard('word-a', 'vocab'), newCard('rule-a', 'grammar', 'SEC')]
  const journal: JournalLine[] = []
  const order = sectionOrder(journal, cards, DAY)
  assert(Array.isArray(order) && order.every(s => SECTIONS.includes(s)), 'sectionOrder обязан вернуть только известные разделы, без перемешивания карточек')
  group('B5: sectionOrder упорядочивает РАЗДЕЛЫ, не карточки внутри раздела')
}

function main(): void {
  console.log('SRS dayplan: приоритет раздела дня по весу RW цифрового SAT (WS6b)')
  priorityWhenGrammarEmptyOfGrades()
  zeroDebtWhenGrammarHasNoWork()
  weightsSumCheck()
  determinismCheck()
  noMixingWithinLesson()
  console.log(`\nВсе проверки плана дня пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ ПЛАНА ДНЯ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
