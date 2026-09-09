/**
 * Тесты корпуса экзаменационного языка (WS9, `src/lib/corpus.ts`): индекс основ по вопросам
 * практики и текстам для чтения, бинарный признак `inCorpus`, тиебрейкер `freshItems`.
 *
 * Фикстуры целиком выдуманные - колода (`sat-deck`) не трогается и в тест не попадает.
 *
 * Запуск: `npm run test:corpus` (esbuild бандлит файл и node его исполняет).
 */
import { createEmptyCard, fsrs, Rating, State } from 'ts-fsrs'
import { buildCorpusIndex, corpusHits, inCorpus } from '../src/lib/corpus'
import { freshItems } from '../src/lib/scheduler'
import type { CardView, QuestionRec, ReadingRec, StudyItem } from '../src/lib/types'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

// ---- фабрики ---------------------------------------------------------------

function qrec(path: string, body: string): QuestionRec {
  return { path, sha: 'sha-1', fm: {}, body }
}

function rrec(path: string, body: string): ReadingRec {
  return { path, sha: 'sha-1', fm: {}, body }
}

function cardView(word: string, level: number, over: Partial<CardView> = {}): CardView {
  return {
    path: `deck/${word}.md`, slug: word, word, pos: 'adj',
    context: `The ___ moment defined ${word}.`,
    contexts: [`The ___ moment defined ${word}.`],
    meaning_en: `meaning of ${word}`, meaning_ru: `${word} по-русски`, roots: '',
    source: 'test', added: '2026-07-20', level, kind: 'vocab',
    domain: '', confusables: [], synonyms: [], other_senses: [], from_mark: [], leech: '', choices: [], answerText: '', answerNum: '',
    desmos: false, explain: '', suspended: false,
    fsrs: createEmptyCard(new Date(2026, 6, 24)),
    prep: '', prepContext: '', fsrsPrep: null,
    ...over
  }
}

function newItem(v: CardView): StudyItem {
  return { view: v, skill: 'recall', fsrs: v.fsrs }
}

// ---- K1: индекс, inCorpus, тиебрейкер --------------------------------------

function corpusIndexChecks(): void {
  const questions: QuestionRec[] = [
    qrec('Учёба/Вопросы/q1.md', 'The tone is emphasized by repetition, which the author uses to great effect.'),
    qrec('Учёба/Вопросы/q2.md', 'A writer who wants to emphasize a claim often repeats the key term.')
  ]
  const readings: ReadingRec[] = [
    rrec('Учёба/Чтение/r1.md', 'Reef fish emphasize colour over size when signalling danger to rivals.')
  ]
  const index = buildCorpusIndex(questions, readings)

  assert(corpusHits(index, 'emphasize') === 3,
    `'emphasized' и 'emphasize' обязаны свестись к одной основе (три вхождения), получили ${corpusHits(index, 'emphasize')}`)
  assert(corpusHits(index, 'emphasized') === corpusHits(index, 'emphasize'),
    'запрос формой из вопроса и словарной формой обязан давать один и тот же счёт')
  assert(!inCorpus(index, 'verisimilitude'), 'слова, которого нет в корпусе, inCorpus обязан отвергать')
  assert(inCorpus(index, 'emphasize'), 'слово из корпуса inCorpus обязан подтверждать')
  group('K1: buildCorpusIndex сводит формы к одной основе, inCorpus честен на отсутствующем слове')
}

function freshItemsTiebreakChecks(): void {
  const inCorpusWord = cardView('buttress', 3)   // ступень 3, есть в корпусе
  const outCorpusWord = cardView('sparse', 2)    // ступень 2, вне корпуса
  const items = [newItem(inCorpusWord), newItem(outCorpusWord)]
  const inCorpus = (slug: string) => slug === 'buttress'

  const order = freshItems(items, new Set(), inCorpus).map(i => i.view.slug)
  assert(order[0] === 'buttress',
    `при равном kindRank слово из корпуса обязано идти раньше слова младшей ступени вне корпуса, получили ${order.join(',')}`)

  // без inCorpus поведение прежнее - level ASC решает
  const orderNoCorpus = freshItems(items, new Set()).map(i => i.view.slug)
  assert(orderNoCorpus[0] === 'sparse',
    `без inCorpus порядок обязан остаться level ASC (sparse раньше buttress), получили ${orderNoCorpus.join(',')}`)

  // живая отметка сильнее inCorpus: отмеченное слово вне корпуса всё равно первое
  const marked = new Set(['sparse'])
  const orderMarked = freshItems(items, marked, inCorpus).map(i => i.view.slug)
  assert(orderMarked[0] === 'sparse',
    `живая отметка не должна перебиваться inCorpus, получили ${orderMarked.join(',')}`)

  group('K1: freshItems - inCorpus встаёт между kindRank и level, живую отметку не перебивает')
}

/**
 * K2 (A11, 10.09.2026): форма уже виденного слова новым словом не вводится.
 *
 * Живой случай: cited введено 05.09 и дозрело до Review, отдельная карточка cite лежала
 * New - урок показал cite окном «новое слово». Дубль по word валит валидатор колоды, но
 * cite/cited по word не совпадают, и очередь обязана держать правило сама: New-карточка
 * словаря с той же основой (lightStem), что у оценивавшегося слова, в fresh не попадает.
 * Две New-формы одного слова (nuance/nuanced) друг друга не блокируют - виденного нет.
 * Единица подготовки виденного слова законно New и остаётся.
 */
function formOfSeenChecks(): void {
  const seen = cardView('cited', 2)
  let c = createEmptyCard(new Date(2026, 8, 5))
  for (let i = 0; i < 5; i++) c = fsrs().next(c, new Date(2026, 8, 5 + i), Rating.Good).card
  seen.fsrs = c
  assert(seen.fsrs.state === State.Review && seen.fsrs.reps === 5, 'фикстура: cited дозрело до Review')
  seen.prep = 'from'
  seen.fsrsPrep = createEmptyCard(new Date(2026, 8, 5))
  const prepOfSeen: StudyItem = { view: seen, skill: 'prep', fsrs: seen.fsrsPrep }

  const items = [newItem(seen), prepOfSeen, newItem(cardView('cite', 2)),
    newItem(cardView('nuance', 1)), newItem(cardView('nuanced', 1))]
  const fresh = freshItems(items).map(i => `${i.skill}:${i.view.slug}`)
  assert(!fresh.includes('recall:cite'),
    `cite - форма виденного cited и новым словом не вводится, получили ${fresh.join(',')}`)
  assert(fresh.includes('recall:nuance') && fresh.includes('recall:nuanced'),
    `две New-формы одного слова друг друга не блокируют, получили ${fresh.join(',')}`)
  assert(fresh.includes('prep:cited'),
    `единица подготовки виденного слова остаётся новой, получили ${fresh.join(',')}`)
  group('K2: freshItems - форма уже виденного слова (cite при виденном cited) новым не вводится')
}

corpusIndexChecks()
freshItemsTiebreakChecks()
formOfSeenChecks()

console.log(`corpus: ${passed} groups passed`)
