/**
 * Тесты раздела «Логика» (src/lib/logic.ts) и его стыка с планировщиком - без React и
 * IndexedDB, как practice/dayplan.
 *
 * Закрывают дефект 09.09.2026: карточки kind error шли через FSRS как слова (learning-шаги,
 * интервалы, у одной карточки reps 8), то есть один и тот же вопрос к отрывку возвращался
 * снова и снова. Вопрос к тексту памятью не берётся: второй показ проверяет, помнит ли ученик
 * букву верного варианта. Модель раздела теперь одноразовая, как у практики: вопрос идёт,
 * пока не решён, и не больше LOGIC_MAX_SHOWS раз, а состояние живёт в журнале, не в fsrs.
 *
 * Запуск: `npm run test:logic` (esbuild бандлит файл и node его исполняет).
 */
import { State, createEmptyCard } from 'ts-fsrs'
import type { CardView, JournalLine } from '../src/lib/types'
import {
  LOGIC_MAX_SHOWS, buildLogicQueue, logicAttempts, logicCounts, logicFreshShownOn,
  logicReviewLine, logicRetryDay, logicSliceCounts, logicStatus, pickLogic
} from '../src/lib/logic'
import {
  buildQueue, expandItems, freshItems, homeCounts, isLogicCard, newBudgetFor, newBudgetTotal,
  nextNewItems, pickTask, sectionOf
} from '../src/lib/scheduler'
import { isLeechCard, maturityBySection } from '../src/lib/metrics'
import { PRACTICE_RETRY_WRONG_DAYS } from '../src/lib/practice'
import { addDaysKey, dayKey } from '../src/lib/daytime'
import { CARD_TIME_CAP_MS, isGraded, reviewsByDay } from '../src/lib/journal'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

const DAY = '2026-08-22'
const NOW = new Date(`${DAY}T10:00:00+04:00`)

/** Карточка раздела «Логика»: вопрос к отрывку с четырьмя авторскими вариантами. */
function logicCard(slug: string, o: Partial<CardView> = {}): CardView {
  return {
    path: `deck/${slug}.md`, slug, word: slug, pos: '',
    context: 'Вопрос к отрывку.', contexts: ['Вопрос к отрывку.'], contextsRu: [],
    meaning_en: '', meaning_ru: '', roots: '',
    source: 'pt4', added: '2026-08-01', level: 999, kind: 'error', domain: 'II',
    confusables: [], synonyms: [], other_senses: [], from_mark: [], leech: '',
    choices: ['A', 'B', 'C', 'D'], answerText: 'A', answerNum: '',
    desmos: false, explain: 'разбор', suspended: false,
    fsrs: createEmptyCard(NOW),
    prep: '', prepContext: '', fsrsPrep: null,
    ...o
  }
}

/** Словарная карточка - для смешанных наборов (раздел «Слова»). */
function wordCard(slug: string): CardView {
  return {
    ...logicCard(slug),
    kind: 'vocab', domain: '', pos: 'adj', level: 1,
    word: slug, meaning_ru: `${slug} по-русски`, meaning_en: `meaning of ${slug}`,
    context: `The ___ moment defined ${slug}.`, contexts: [`The ___ moment defined ${slug}.`],
    choices: [], answerText: '', explain: ''
  }
}

/** Попытка по вопросу логики в журнале. */
function attempt(slug: string, day: string, correct: boolean, ms = 0): JournalLine {
  return {
    id: `${slug}-${day}-${ms}`, v: 1, type: 'review', ts: `${day}T12:00:00+04:00`, ms,
    day, slug, skill: 'recall', format: 'mc', correct, kind: 'error', domain: 'II'
  }
}

// ---- L1: статусы вопроса считаются по журналу ------------------------------

function statusChecks(): void {
  const slug = 'log-ii-most'
  assert(logicStatus(slug, []) === 'fresh', 'без попыток вопрос свежий')

  const одна = [attempt(slug, '2026-08-20', false)]
  assert(logicStatus(slug, одна) === 'retry', 'одна неверная попытка - вопрос ждёт возврата')

  const верная = [...одна, attempt(slug, '2026-08-22', true)]
  assert(logicStatus(slug, верная) === 'solved', 'верная попытка закрывает вопрос')

  const три = [
    attempt(slug, '2026-08-16', false),
    attempt(slug, '2026-08-18', false),
    attempt(slug, '2026-08-20', false)
  ]
  assert(три.length === LOGIC_MAX_SHOWS, 'предпосылка: показов ровно столько, сколько разрешено')
  assert(logicStatus(slug, три.slice(0, 2)) === 'retry', `до ${LOGIC_MAX_SHOWS} показов вопрос ещё возвращается`)
  assert(logicStatus(slug, три) === 'closed', `после ${LOGIC_MAX_SHOWS} неверных вопрос закрыт`)
  assert(logicStatus(slug, [...три, attempt(slug, '2026-08-21', true)]) === 'solved',
    'верный ответ сильнее лимита показов: решённый вопрос не «ошибка»')

  // чужие строки в счёт не идут
  const шум: JournalLine[] = [
    { ...attempt(slug, '2026-08-19', false), type: 'practice' },
    { ...attempt('другой-вопрос', '2026-08-19', false) },
    { id: 'intro', v: 1, type: 'review', ts: `2026-08-19T12:00:00+04:00`, day: '2026-08-19', slug, skill: 'recall', format: 'intro' }
  ]
  assert(logicStatus(slug, шум) === 'fresh', 'практика, чужой слаг и показ без результата попытками не считаются')
  assert(logicAttempts([...шум, ...три], slug).length === 3, 'logicAttempts берёт только попытки своего вопроса')

  // хронология: порядок по ts, при равенстве по ms (тайбрейк D1)
  const вРазнобой = [attempt(slug, '2026-08-20', false, 300), attempt(slug, '2026-08-20', true, 100)]
  const порядок = logicAttempts(вРазнобой, slug)
  assert(порядок[0].ms === 100 && порядок[1].ms === 300, 'попытки одной секунды упорядочены по ms')

  group('L1: статус вопроса (fresh/retry/solved/closed) считается по журналу, чужие строки не в счёт')
}

// ---- L2: день возврата ------------------------------------------------------

function retryDayChecks(): void {
  const last = attempt('log-ii-most', '2026-08-20', false)
  assert(logicRetryDay(last) === addDaysKey('2026-08-20', PRACTICE_RETRY_WRONG_DAYS),
    'день возврата - день попытки плюс PRACTICE_RETRY_WRONG_DAYS')
  assert(logicRetryDay(last) === '2026-08-22', 'через два дня после 20.08 - это 22.08')

  const карточка = logicCard('log-ii-most')
  const журнал = [attempt('log-ii-most', '2026-08-21', false)]  // созреет 23.08
  assert(pickLogic([карточка], журнал, 3, NOW).length === 0,
    'не созревший возврат в очередь не идёт (22.08 при сроке 23.08)')
  assert(pickLogic([карточка], журнал, 3, new Date('2026-08-23T10:00:00+04:00')).length === 1,
    'в свой день возврат появляется')
  assert(logicCounts([карточка], журнал, 3, NOW).left === 1,
    'но из «осталось» он не исчезает: это долг, а не решённый вопрос')

  group('L2: возврат через PRACTICE_RETRY_WRONG_DAYS, до срока вопрос в очередь не идёт и из долга не пропадает')
}

// ---- L3: порядок и бюджет очереди -------------------------------------------

function pickOrderChecks(): void {
  const свежие = [
    logicCard('log-c', { added: '2026-08-03' }),
    logicCard('log-a', { added: '2026-08-01' }),
    logicCard('log-b', { added: '2026-08-01' })   // тот же added: тайбрейк по слагу
  ]
  const порядок = pickLogic(свежие, [], 10, NOW).map(v => v.slug)
  assert(порядок.join(',') === 'log-a,log-b,log-c',
    `свежие идут по added, при равенстве по слагу: получено ${порядок.join(',')}`)

  // бюджет режет только свежие
  assert(pickLogic(свежие, [], 2, NOW).map(v => v.slug).join(',') === 'log-a,log-b', 'бюджет режет хвост свежих')
  assert(pickLogic(свежие, [], 0, NOW).length === 0, 'нулевой бюджет не выдаёт ни одного свежего вопроса')

  // возвраты впереди свежих, самые просроченные первыми
  const возвраты = [
    logicCard('log-late', { added: '2026-08-01' }),   // провален 20.08, срок 22.08
    logicCard('log-old', { added: '2026-08-01' })     // провален 16.08, срок 18.08
  ]
  const журнал = [attempt('log-late', '2026-08-20', false), attempt('log-old', '2026-08-16', false)]
  const смешанная = pickLogic([...свежие, ...возвраты], журнал, 10, NOW).map(v => v.slug)
  assert(смешанная.slice(0, 2).join(',') === 'log-old,log-late',
    `возвраты идут первыми и от самых просроченных: получено ${смешанная.join(',')}`)
  assert(смешанная.slice(2).join(',') === 'log-a,log-b,log-c', 'свежие идут за возвратами своим порядком')

  // возврат бюджетом не режется: это долг, а не знакомство
  assert(pickLogic([...свежие, ...возвраты], журнал, 0, NOW).map(v => v.slug).join(',') === 'log-old,log-late',
    'нулевой бюджет новых не отменяет созревшие возвраты')

  // решённое и закрытое не показывается никогда
  const закрытые = [
    { card: logicCard('log-solved'), lines: [attempt('log-solved', '2026-08-01', true)] },
    {
      card: logicCard('log-closed'),
      lines: [
        attempt('log-closed', '2026-08-01', false),
        attempt('log-closed', '2026-08-03', false),
        attempt('log-closed', '2026-08-05', false)
      ]
    }
  ]
  for (const { card, lines } of закрытые) {
    assert(pickLogic([card], lines, 10, NOW).length === 0, `${card.slug}: закрытый вопрос в очередь не идёт`)
    assert(pickLogic([card], lines, 10, new Date('2026-12-01T10:00:00+04:00')).length === 0,
      `${card.slug}: и через месяцы тоже - у одноразовой модели срока годности нет`)
  }

  // отложенная карточка и чужой раздел
  assert(pickLogic([logicCard('log-susp', { suspended: true })], [], 10, NOW).length === 0, 'отложенный вопрос не выдаётся')
  assert(pickLogic([wordCard('candid')], [], 10, NOW).length === 0, 'словарная карточка в очередь логики не попадает')
  assert(pickLogic([logicCard('log-math', { kind: 'error', domain: 'ALG' })], [], 10, NOW).length === 0,
    'kind error с математическим доменом - это математика (лестница sectionOf), а не логика')

  // стоп ввода раздела (A8) закрывает свежие, но не долг
  const послеСтопа = new Date(2026, 8, 27, 10, 0, 0)   // 27.09.2026, логика закрыта с 26.09
  assert(pickLogic(свежие, [], 10, послеСтопа).length === 0, 'после стопа ввода свежие вопросы не выдаются')
  assert(pickLogic(возвраты, журнал, 10, послеСтопа).length === 2, 'а созревшие возвраты после стопа остаются')

  group('L3: порядок очереди (возвраты по просрочке, свежие по added), бюджет, решённые/закрытые/незрелые не выдаются')
}

// ---- L4: счётчики раздела ---------------------------------------------------

function countsChecks(): void {
  const cards = [
    logicCard('log-fresh1', { added: '2026-08-01' }),
    logicCard('log-fresh2', { added: '2026-08-02' }),
    logicCard('log-due', { added: '2026-08-03' }),
    logicCard('log-later', { added: '2026-08-04' }),
    logicCard('log-solved', { added: '2026-08-05' }),
    logicCard('log-closed', { added: '2026-08-06' })
  ]
  const журнал = [
    attempt('log-due', '2026-08-18', false),
    attempt('log-later', '2026-08-21', false),
    attempt('log-solved', '2026-08-10', true),
    attempt('log-closed', '2026-08-01', false),
    attempt('log-closed', '2026-08-03', false),
    attempt('log-closed', '2026-08-05', false)
  ]

  const c = logicCounts(cards, журнал, 1, NOW)
  assert(c.left === 4, `«осталось» - свежие и оба возврата: 4, получено ${c.left}`)
  assert(c.solved === 1, `«разобрано» - 1, получено ${c.solved}`)
  assert(c.wrong === 1, `«ошибок» - 1 закрытый, получено ${c.wrong}`)
  assert(c.avail === 2, `«разбирать» - созревший возврат плюс один свежий по бюджету, получено ${c.avail}`)
  assert(c.avail === pickLogic(cards, журнал, 1, NOW).length, 'avail обязан совпадать с длиной очереди')
  assert(c.left + c.solved + c.wrong === cards.length, 'сумма счётчиков сходится с числом карточек раздела')

  const s = logicSliceCounts(cards, журнал, NOW)
  assert(s.fresh === 2 && s.retryDue === 1 && s.retryLater === 1 && s.retryTomorrow === 1,
    `срез раздела: ${JSON.stringify(s)}`)

  group('L4: счётчики раздела (осталось / разобрано / ошибок / доступно) сходятся с очередью и с числом карточек')
}

// ---- L5: изъятие из FSRS-потока --------------------------------------------

/** Живой случай: карточка логики, доросшая в старом потоке до Review с reps 8 и просроченным
 *  сроком. По FSRS это «созревший повтор», причём образцовая пиявка. */
function старая(slug: string): CardView {
  const base = createEmptyCard(NOW)
  return logicCard(slug, {
    fsrs: {
      ...base, state: State.Review, reps: 8, lapses: 3, stability: 1.2, difficulty: 8,
      due: new Date(NOW.getTime() - 3 * 86400_000), last_review: new Date(NOW.getTime() - 5 * 86400_000)
    }
  })
}

function outOfFsrsChecks(): void {
  const карточка = старая('log-ii-most-cifry')
  assert(sectionOf(карточка) === 'logic' && isLogicCard(карточка), 'предпосылка: это раздел «Логика»')
  assert(карточка.fsrs.state === State.Review && карточка.fsrs.reps === 8,
    'предпосылка репро: по FSRS карточка - созревший повтор с восемью показами')

  const слово = wordCard('candid')
  const deck = [карточка, слово]

  assert(expandItems(deck, NOW).every(i => i.view.slug !== карточка.slug),
    'репро: карточка логики больше не разворачивается в учебную единицу FSRS')
  assert(freshItems(expandItems(deck, NOW)).every(i => i.view.slug !== карточка.slug),
    'и в поток новых тоже не попадает')
  assert(nextNewItems(deck, new Set(), 5, NOW).every(i => i.view.slug !== карточка.slug),
    'добор сверх урочного лимита её тоже не берёт')

  // очередь: без журнала вопрос свежий, после ответа - его нет
  const пустойЖурнал: JournalLine[] = []
  const q = buildQueue(deck, 3, NOW, undefined, new Set(), undefined, пустойЖурнал)
  const вОчереди = q.filter(i => i.view.slug === карточка.slug)
  assert(вОчереди.length === 1, 'вопрос логики приходит в очередь ровно один раз')
  assert(вОчереди[0].skill === 'recall', 'навык у разбора один - recall')
  assert(pickTask(вОчереди[0], deck, undefined, undefined, true, true, NOW).format === 'mc',
    'формат показа - mc: у карточки авторские варианты, ротации словаря у неё нет')

  const журнал = [attempt(карточка.slug, DAY, false)]
  assert(buildQueue(deck, 3, NOW, undefined, new Set(), undefined, журнал)
    .every(i => i.view.slug !== карточка.slug),
    'репро: отвеченный сегодня вопрос не возвращается ни повтором, ни новым')

  /* Главная: замок «есть что выдать» (moreAvail в Summary.tsx, hasWork в dayplan.ts) держится
     на счётчиках раздела, а не на fsrs. Счётчики считаются на срезе раздела - ровно так их и
     зовут экраны (Home.tsx, Summary.tsx фильтруют колоду по sectionOf). */
  const разделЛогики = [карточка]
  const без = homeCounts(разделЛогики, 3, NOW, пустойЖурнал)
  assert(без.learnDue === 0, 'learning-ступеней у логики нет')
  assert(без.revDue === 0, `репро: просроченный fsrs-срок логики повтором больше не считается, получено ${без.revDue}`)
  assert(без.newAvail === 1, `свежий вопрос логики виден плашкой «новые», получено ${без.newAvail}`)
  assert(без.byState.new + без.byState.learning + без.byState.review === без.total,
    'разбивка по состояниям сходится с числом активных карточек')
  assert(без.byState.new === 1 && без.byState.review === 0,
    'и не читает замороженный fsrs.state: по FSRS эта карточка «Review», по журналу - непоказанная')

  const после = homeCounts(разделЛогики, 3, NOW, журнал)
  assert(после.newAvail === 0 && после.revDue === 0,
    'после ответа сегодня разделу нечего выдать: замок «Ещё заход» закрыт')
  const созрел = new Date('2026-08-24T10:00:00+04:00')
  assert(homeCounts(разделЛогики, 3, созрел, журнал).revDue === 1,
    'в день возврата долг раздела снова виден на главной')
  assert(homeCounts(разделЛогики, 3, созрел, журнал).newAvail === 0, 'и возврат не притворяется новым вопросом')
  assert(homeCounts(разделЛогики, 3, NOW, [attempt(карточка.slug, '2026-08-10', true)]).byState.review === 1,
    'разобранный вопрос в разбивке по состояниям стоит там, где работа кончена')

  // счётчики главной и очередь урока обязаны сходиться
  for (const [день, ж] of [[NOW, пустойЖурнал], [созрел, журнал]] as const) {
    const c = homeCounts(разделЛогики, 3, день, ж)
    const выдаст = buildQueue(разделЛогики, 3, день, undefined, new Set(), undefined, ж)
      .filter(i => isLogicCard(i.view)).length
    assert(c.revDue + c.newAvail === выдаст, 'плашка главной обещает ровно то, что выдаст урок')
    assert(выдаст === logicCounts(разделЛогики, ж, 3, день).avail, 'очередь урока и avail раздела - одно число')
  }

  // метрики: логика не пиявка и не «зрелая по fsrs»
  assert(!isLeechCard(карточка), 'репро: карточка логики с reps 8 и стабильностью 1,2 дня пиявкой не считается')
  const m = maturityBySection(разделЛогики, журнал)
  assert(m.logic.total === 1 && m.logic.reviewCount === 0 && m.logic.matureCount === 0,
    `зрелость логики считается по журналу: непройденный вопрос не «доведён», получено ${JSON.stringify(m.logic)}`)
  const решено = [attempt(карточка.slug, DAY, true)]
  assert(maturityBySection(разделЛогики, решено).logic.matureCount === 1,
    'разобранный верно вопрос - это и есть «закреплено» для логики')

  group('L5: карточка логики с fsrs state 2 и reps 8 не выдаётся ни повтором, ни пиявкой - её ведёт журнал')
}

// ---- L6: дневной бюджет ввода ----------------------------------------------

function budgetChecks(): void {
  const cards = [logicCard('log-a'), logicCard('log-b'), logicCard('log-c')]
  assert(newBudgetFor(cards, 3, [], DAY) === 3, 'без вводов сегодня бюджет раздела цел')

  const сегодня = [attempt('log-a', DAY, false)]
  assert(logicFreshShownOn(сегодня, DAY, new Set(['log-a', 'log-b'])) === 1, 'первая попытка сегодня - это ввод')
  assert(newBudgetFor(cards, 3, сегодня, DAY) === 2, 'показанный сегодня свежий вопрос списывается с бюджета')

  const повтор = [attempt('log-a', '2026-08-18', false), attempt('log-a', DAY, false)]
  assert(logicFreshShownOn(повтор, DAY, new Set(['log-a'])) === 0,
    'возврат к старому вопросу бюджет ввода не тратит: введён он был в свой день')
  assert(newBudgetFor(cards, 3, повтор, DAY) === 3, 'и бюджет остаётся целым')

  // смешанный набор: слово и вопрос считаются каждый своим признаком ввода
  const слово = wordCard('candid')
  const журналСмешанный: JournalLine[] = [
    ...сегодня,
    { id: 'w1', v: 1, type: 'review', ts: `${DAY}T11:00:00+04:00`, day: DAY, slug: 'candid', skill: 'recall', prev_state: State.New, rating: 3 }
  ]
  assert(newBudgetFor([...cards, слово], 4, журналСмешанный, DAY) === 2,
    'на смешанном наборе списываются оба ввода: и слово (prev_state 0), и вопрос (первая попытка)')

  // общий остаток колоды: «новых в разделе» у логики считается по журналу, а не по fsrs.state
  const решено = [attempt('log-a', '2026-08-10', true), attempt('log-b', '2026-08-10', true)]
  assert(newBudgetTotal(cards, 3, решено, DAY) === 1,
    'разобранные вопросы не обещают ввода, которого урок не даст: остаётся один свежий')

  group('L6: дневной бюджет ввода логики списывается первой попыткой по вопросу, а не prev_state FSRS')
}

// ---- L7: строка журнала вместо rateItem ------------------------------------

function reviewLineChecks(): void {
  const карточка = logicCard('log-ii-most')
  const line = logicReviewLine(карточка, false, 9_000, 7_000, NOW)

  assert(line.type === 'review' && line.slug === карточка.slug, 'строка review своего вопроса')
  assert(line.skill === 'recall' && line.format === 'mc', 'навык recall, формат mc')
  assert(line.correct === false, 'объективный результат пишется полем correct')
  assert(line.kind === 'error' && line.domain === 'II', 'вид и домен карточки едут в строку')
  assert(line.day === dayKey(NOW) && line.ts.startsWith('2026-08-22') && line.ms === NOW.getMilliseconds(),
    'день, отметка времени и миллисекунды - как у остальных строк журнала')
  assert(line.elapsed_ms === 9_000 && line.answer_ms === 7_000, 'замеры времени доезжают до журнала')
  assert(logicReviewLine(карточка, true, 30 * 60_000, undefined, NOW).elapsed_ms === CARD_TIME_CAP_MS,
    'замер за потолком зажимается тем же journalElapsedMs, что и у rateItem')
  assert(logicReviewLine(карточка, true, 1_000, undefined, NOW).answer_ms === undefined,
    'без отдельного времени ответа поле не выдумывается')

  assert(line.prev_state === undefined && line.new_state === undefined && line.due === undefined && line.stability === undefined,
    'полей FSRS в строке нет: у логики нет ни состояния, ни срока')
  assert(isGraded(line), 'разобранный вопрос обязан считаться работой дня (isGraded), иначе день его не видит')
  assert((reviewsByDay([line]).get(DAY) ?? 0) === 1, 'и попадать в счётчик упражнений дня')

  const верная = logicReviewLine(карточка, true, 5_000, 5_000, NOW)
  assert(logicStatus(карточка.slug, [line]) === 'retry' && logicStatus(карточка.slug, [верная]) === 'solved',
    'строка, записанная logicReviewLine, читается обратно logicStatus - контур замкнут')

  group('L7: logicReviewLine пишет ответ без FSRS, но день и статус вопроса его видят')
}

// ---- L8: очередь раздела в учебных единицах ---------------------------------

function queueChecks(): void {
  const cards = [logicCard('log-a', { added: '2026-08-01' }), logicCard('log-b', { added: '2026-08-02' })]
  const items = buildLogicQueue(cards, [], 1, NOW)
  assert(items.length === 1 && items[0].view.slug === 'log-a', 'buildLogicQueue отдаёт ту же очередь, что pickLogic')
  assert(items[0].fsrs === cards[0].fsrs, 'учебная единица несёт fsrs-блок карточки как есть, не выдумывая его')

  // отдельный вызов и хвост buildQueue дают одно и то же
  const хвост = buildQueue(cards, 1, NOW, undefined, new Set(), undefined, []).map(i => i.view.slug)
  assert(хвост.join(',') === 'log-a', `хвост buildQueue совпадает с buildLogicQueue: получено ${хвост.join(',')}`)

  /* Смешанный набор (так очередь строят только сводки, урок всегда идёт по срезу раздела):
     дневной бюджет один на вызов и делится между разделами, а не выдаётся каждому целиком. */
  const слова = [wordCard('candid'), wordCard('lucid')]
  const смешанная = buildQueue([...слова, ...cards], 3, NOW, undefined, new Set(), undefined, [])
  const логикаВОчереди = смешанная.filter(i => isLogicCard(i.view))
  assert(смешанная.length === 3, `бюджет 3 на четырёх новых карточках даёт три показа, получено ${смешанная.length}`)
  assert(логикаВОчереди.length === 1 && смешанная.length - логикаВОчереди.length === 2,
    `бюджет делится между разделами: два слова и один вопрос, получено ${смешанная.map(i => i.view.slug).join(',')}`)
  assert(смешанная.slice(-1).every(i => isLogicCard(i.view)),
    'логика идёт хвостом очереди: предметы внутри урока не перемешиваются')
  assert(buildQueue([...слова, ...cards], 4, NOW, undefined, new Set(), undefined, [])
    .filter(i => isLogicCard(i.view)).length === 2, 'при бюджете 4 логике достаётся остаток после слов')

  group('L8: очередь логики - учебные единицы recall, хвостом общей очереди, с общим дневным бюджетом')
}

function main(): void {
  console.log('SRS логика: одноразовая модель раздела «Логика» (kind error, домены II/CS/EOI)')
  statusChecks()
  retryDayChecks()
  pickOrderChecks()
  countsChecks()
  outOfFsrsChecks()
  budgetChecks()
  reviewLineChecks()
  queueChecks()
  console.log(`\nВсе проверки раздела «Логика» пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ РАЗДЕЛА «ЛОГИКА» УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
