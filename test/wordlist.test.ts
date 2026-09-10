/**
 * Тесты единого источника правды о состоянии одного слова (`src/lib/wordstatus.ts`).
 *
 * Модуль заведён взамен двух самостоятельных выражений на главном экране («введено» —
 * фильтром прямо в разметке, «закрепилось» — через `maturity().matureCount`), которые
 * совпадали случайно. Поэтому первая и главная проверка набора — не про отдельную стадию,
 * а про согласие с этими двумя старыми выражениями: если кто-то поменяет порядок проверок
 * в `wordStatus` и снимет правило (например, приоритет пиявки над Review), юнит-проверки
 * по одной стадии могут не заметить сдвига в сумме, а инвариант согласия — обязан. Она
 * стоит ПЕРВОЙ в группе намеренно: на этот порядок в репозитории уже наступали — падение
 * позже мелких юнитов означает, что упадёт юнит, а инвариант не исполнится вовсе.
 *
 * Запуск: `npm run test:wordlist` (esbuild бандлит файл и node его исполняет).
 */
import { State, type Card as FsrsCard } from 'ts-fsrs'
import type { CardView } from '../src/lib/types'
import {
  wordStatus, stageCounts, filterWords, isWordCard, STAGE_ORDER, STAGE_LABEL, type WordStage
} from '../src/lib/wordstatus'
import { isLevelled } from '../src/lib/scheduler'
import { maturity, LEECH_REPS, LEECH_STABILITY_DAYS, MATURE_STABILITY_DAYS } from '../src/lib/metrics'
import { screenSource } from './screen-source'
import { readFileSync } from 'node:fs'
import path from 'node:path'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

// ---- фабрики ---------------------------------------------------------------

function fsrsCard(over: Partial<FsrsCard> = {}): FsrsCard {
  return {
    due: new Date('2026-09-01T00:00:00Z'),
    stability: 0,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 3,
    lapses: 0,
    state: State.Review,
    last_review: new Date('2026-08-20T00:00:00Z'),
    ...over
  }
}

let seq = 0
function vocab(word: string, f: FsrsCard, over: Partial<CardView> = {}): CardView {
  seq++
  return {
    path: `deck/${word}.md`, slug: `${word}-${seq}`, word, pos: 'noun', context: '', contexts: [],
    contextsRu: [], meaning_en: `en:${word}`, meaning_ru: `значение ${word}`, roots: '',
    source: 'test', added: '2026-07-01', level: 1, kind: 'vocab', domain: '', confusables: [], synonyms: [], other_senses: [], from_mark: [],
    leech: '', choices: [], answerText: '', answerNum: '', desmos: false, explain: '',
    suspended: false, fsrs: f, prep: '', prepContext: '', fsrsPrep: null, ...over
  } as CardView
}

/** Несловарная карточка (математика/грамматика/разбор) — не должна попадать ни в список, ни в счётчики. */
function exercise(word: string, f: FsrsCard, kind: string, over: Partial<CardView> = {}): CardView {
  return vocab(word, f, { kind, ...over })
}

// ---- главная проверка: согласие с нынешними выражениями главной ------------

/** То же самое условие, что раньше стояло в JSX Home.tsx: introduced. */
function homeIntroducedExpr(cards: CardView[]): number {
  return cards.filter(v => isLevelled(v) && !v.suspended && v.fsrs.state !== State.New).length
}

function agreementWithHomeChecks(): void {
  const deck: CardView[] = [
    vocab('new1', fsrsCard({ state: State.New, stability: 0, reps: 0, lapses: 0 })),
    vocab('learn1', fsrsCard({ state: State.Learning, stability: 0.3, reps: 1 })),
    vocab('relearn1', fsrsCard({ state: State.Relearning, stability: 0.4, reps: 4, lapses: 1 })),
    vocab('rev1', fsrsCard({ state: State.Review, stability: 5, reps: 5 })),
    vocab('mature1', fsrsCard({ state: State.Review, stability: 21, reps: 6 })),
    vocab('mature2', fsrsCard({ state: State.Review, stability: 40, reps: 10 })),
    vocab('leech1', fsrsCard({ state: State.Review, stability: 1, reps: LEECH_REPS })),
    vocab('susp1', fsrsCard({ state: State.Review, stability: 21, reps: 5 }), { suspended: true }),
    vocab('susp2', fsrsCard({ state: State.New, stability: 0, reps: 0 }), { suspended: true }),
    exercise('mathcard', fsrsCard({ state: State.Review, stability: 21, reps: 5 }), 'math')
  ]

  const counts = stageCounts(deck)
  const introducedFromStages = counts.reduce((sum, c) => sum + (c.stage === 'new' || c.stage === 'suspended' ? 0 : c.n), 0)
  const matureFromStages = counts.find(c => c.stage === 'mature')!.n

  assert(introducedFromStages === homeIntroducedExpr(deck),
    `инвариант нарушен: stageCounts (без new/suspended) даёт ${introducedFromStages}, ` +
    `нынешнее выражение главной — ${homeIntroducedExpr(deck)}`)
  assert(matureFromStages === maturity(deck).matureCount,
    `инвариант нарушен: stageCounts.mature даёт ${matureFromStages}, maturity().matureCount — ${maturity(deck).matureCount}`)

  group('ГЛАВНОЕ: сумма стадий (кроме new/suspended) и stage=mature совпадают с нынешними выражениями главной')
}

/**
 * Единственное намеренное расхождение с `maturity().matureCount` — и оно закреплено здесь,
 * чтобы никогда не появиться случайно.
 *
 * `isLeechCard` считает пиявкой карточку, у которой застрял ЛИБО сам показ слова, ЛИБО навык
 * предлога (`fsrsPrep`). Слово со стабильностью выше порога и проваленным навыком предлога
 * `maturity()` посчитает зрелым, а этот модуль — «застрявшим». Так и надо: закреплённым
 * слово, у которого провален навык, называть нельзя, а экран списка заводится ровно затем,
 * чтобы такое было видно. На 23.08.2026 расхождение чисто теоретическое: в живой колоде нет
 * ни одной карточки с полем `prep`, `fsrsPrep` везде пуст, и числа сходятся до единицы.
 */
function prepLeechDivergenceChecks(): void {
  const застрявшийНавык = fsrsCard({ state: State.Review, stability: 1, reps: LEECH_REPS })
  const слово = vocab('adhere', fsrsCard({ state: State.Review, stability: 40, reps: 12 }), {
    prep: 'to', fsrsPrep: застрявшийНавык
  })

  assert(wordStatus(слово).stage === 'leech',
    `слово со зрелой стабильностью, но застрявшим навыком предлога — «застряло», получено «${wordStatus(слово).stage}»`)

  const колода = [слово]
  const mature = stageCounts(колода).find(c => c.stage === 'mature')!.n
  assert(mature === 0 && maturity(колода).matureCount === 1,
    'расхождение с maturity() ровно здесь и ровно на этих словах — если счётчики сошлись, приоритет пиявки потерян')

  // без навыка предлога то же слово зрелое: расхождение создаёт именно prep, а не стабильность
  const безНавыка = vocab('adhere2', fsrsCard({ state: State.Review, stability: 40, reps: 12 }))
  assert(wordStatus(безНавыка).stage === 'mature', 'то же слово без навыка предлога — «закрепилось»')

  group('расхождение с maturity() только на застрявшем навыке предлога — намеренное и единственное')
}

// ---- каждая стадия по отдельности ------------------------------------------

function stageByStageChecks(): void {
  assert(wordStatus(vocab('w', fsrsCard({ state: State.New, stability: 0, reps: 0, lapses: 0 }))).stage === 'new',
    'New → new')
  assert(wordStatus(vocab('w', fsrsCard({ state: State.Learning, stability: 0.2, reps: 1 }))).stage === 'learning',
    'Learning → learning')
  assert(wordStatus(vocab('w', fsrsCard({ state: State.Relearning, stability: 0.3, reps: 4, lapses: 1 }))).stage === 'learning',
    'Relearning → learning')
  assert(wordStatus(vocab('w', fsrsCard({ state: State.Review, stability: 5, reps: 5 }))).stage === 'review',
    'Review со стабильностью 5 → review')
  assert(wordStatus(vocab('w', fsrsCard({ state: State.Review, stability: MATURE_STABILITY_DAYS, reps: 5 }))).stage === 'mature',
    `Review со стабильностью ровно на пороге (${MATURE_STABILITY_DAYS}) → mature: граница включительно`)
  assert(wordStatus(vocab('w', fsrsCard({ state: State.Review, stability: MATURE_STABILITY_DAYS - 0.1, reps: 5 }))).stage === 'review',
    `Review со стабильностью чуть ниже порога (${MATURE_STABILITY_DAYS - 0.1}) → review, ещё не mature`)
  group('каждая стадия по отдельности: New/Learning/Relearning/Review/mature и граница порога')
}

function suspendedBeatsAllChecks(): void {
  const susMature = vocab('w', fsrsCard({ state: State.Review, stability: 40, reps: 10 }), { suspended: true })
  assert(wordStatus(susMature).stage === 'suspended', 'suspended перебивает mature')
  const susLeech = vocab('w', fsrsCard({ state: State.Review, stability: 1, reps: LEECH_REPS }), { suspended: true })
  assert(wordStatus(susLeech).stage === 'suspended', 'suspended перебивает пиявку')
  const susNew = vocab('w', fsrsCard({ state: State.New, stability: 0, reps: 0 }), { suspended: true })
  assert(wordStatus(susNew).stage === 'suspended', 'suspended перебивает даже New')
  group('suspended перебивает всё, включая пиявку и mature')
}

function leechChecks(): void {
  // reps >= LEECH_REPS и stability < LEECH_STABILITY_DAYS — пиявка, а не review/learning
  const leechInReview = vocab('w', fsrsCard({ state: State.Review, stability: LEECH_STABILITY_DAYS - 0.5, reps: LEECH_REPS }))
  assert(wordStatus(leechInReview).stage === 'leech', 'Review с малой стабильностью и reps>=LEECH_REPS → leech, не review')
  const leechInLearning = vocab('w', fsrsCard({ state: State.Learning, stability: 0.1, reps: LEECH_REPS + 3 }))
  assert(wordStatus(leechInLearning).stage === 'leech', 'Learning тоже подпадает под пиявку, если reps/stability совпали')
  // недостаточно повторов — не пиявка, несмотря на низкую стабильность
  const notEnoughReps = vocab('w', fsrsCard({ state: State.Review, stability: 0.1, reps: LEECH_REPS - 1 }))
  assert(wordStatus(notEnoughReps).stage !== 'leech', 'меньше LEECH_REPS повторов — ещё не пиявка')
  group('пиявка: reps >= LEECH_REPS и stability < LEECH_STABILITY_DAYS дают leech, а не learning/review')
}

function progressChecks(): void {
  assert(wordStatus(vocab('w', fsrsCard({ state: State.New, stability: 0, reps: 0 }))).progress === 0,
    'progress у new — 0')
  assert(wordStatus(vocab('w', fsrsCard({ state: State.Review, stability: 40, reps: 5 }), { suspended: true })).progress === 0,
    'progress у suspended — 0 независимо от stability')
  assert(wordStatus(vocab('w', fsrsCard({ state: State.Review, stability: MATURE_STABILITY_DAYS, reps: 5 }))).progress === 1,
    'progress ровно 1 при стабильности ровно на пороге')
  assert(wordStatus(vocab('w', fsrsCard({ state: State.Review, stability: MATURE_STABILITY_DAYS * 5, reps: 5 }))).progress === 1,
    'progress не превышает 1 при стабильности сильно выше порога')
  const half = wordStatus(vocab('w', fsrsCard({ state: State.Review, stability: MATURE_STABILITY_DAYS / 2, reps: 5 }))).progress
  assert(Math.abs(half - 0.5) < 1e-9, `progress на середине пути должен быть 0.5, получено ${half}`)
  group('progress: 0 у new/suspended, 1 на пороге и выше, ожидаемая доля посередине')
}

// ---- stageCounts -------------------------------------------------------------

function stageCountsChecks(): void {
  const deck: CardView[] = [
    vocab('n', fsrsCard({ state: State.New, stability: 0, reps: 0 })),
    vocab('r', fsrsCard({ state: State.Review, stability: 5, reps: 5 })),
    exercise('m', fsrsCard({ state: State.Review, stability: 21, reps: 5 }), 'math')
  ]
  const counts = stageCounts(deck)
  assert(counts.length === STAGE_ORDER.length, `stageCounts обязан вернуть все ${STAGE_ORDER.length} стадий, получено ${counts.length}`)
  assert(counts.map(c => c.stage).join(',') === STAGE_ORDER.join(','), 'порядок стадий обязан совпадать со STAGE_ORDER')
  const zeroStages = counts.filter(c => c.n === 0)
  assert(zeroStages.length > 0, 'пустые стадии должны присутствовать с n=0, а не пропадать из списка')
  const total = counts.reduce((a, c) => a + c.n, 0)
  const wordCardsCount = deck.filter(isWordCard).length
  assert(total === wordCardsCount, `сумма n (${total}) должна равняться числу словарных карточек (${wordCardsCount}), math в счёт не идёт`)
  group('stageCounts: все стадии STAGE_ORDER, включая нулевые, сумма n = число словарных карточек')
}

// ---- filterWords -------------------------------------------------------------

function filterWordsChecks(): void {
  const deck: CardView[] = [
    vocab('Bolster', fsrsCard({ state: State.Review, stability: 1, reps: LEECH_REPS }), { meaning_ru: 'подкреплять' }),
    vocab('Apple', fsrsCard({ state: State.New, stability: 0, reps: 0 }), { meaning_ru: 'яблоко' }),
    vocab('Corroborate', fsrsCard({ state: State.Review, stability: 5, reps: 5 }), { meaning_ru: 'подтверждать независимым источником' }),
    vocab('Deter', fsrsCard({ state: State.Review, stability: 40, reps: 8 }), { meaning_ru: 'отпугивать' }),
    vocab('Yield', fsrsCard({ state: State.Learning, stability: 0.5, reps: 1 }), { meaning_ru: 'уступать' }),
    vocab('Zephyr', fsrsCard({ state: State.Review, stability: 30, reps: 8 }), { meaning_ru: 'лёгкий ветер' }, ),
    exercise('mathex', fsrsCard({ state: State.Review, stability: 21, reps: 5 }), 'math')
  ]

  // пустой запрос ничего не отсекает (кроме несловарных карточек)
  const all = filterWords(deck, '', null)
  assert(all.length === deck.filter(isWordCard).length, 'пустой запрос не должен отсекать словарные карточки')
  assert(!all.some(v => v.kind !== 'vocab'), 'несловарные карточки не участвуют в списке')

  // поиск по слову, регистронезависимо
  const byWord = filterWords(deck, 'boLSTer', null)
  assert(byWord.length === 1 && byWord[0].word === 'Bolster', 'поиск по слову регистронезависим')

  // поиск по русскому значению, регистронезависимо
  const byMeaning = filterWords(deck, 'ПОДТВЕРЖДАТЬ', null)
  assert(byMeaning.length === 1 && byMeaning[0].word === 'Corroborate', 'поиск по meaning_ru регистронезависим')

  // фильтр по стадии
  const matureOnly = filterWords(deck, '', 'mature')
  assert(matureOnly.every(v => wordStatus(v).stage === 'mature'), 'фильтр по стадии отсекает верно')
  assert(matureOnly.length === 2, `ожидалось 2 mature-слова (Deter, Zephyr), получено ${matureOnly.length}`)

  // stage === null — без фильтра по стадии
  assert(filterWords(deck, '', null).length === filterWords(deck, '', null).length, 'stage=null не фильтрует по стадии')

  // порядок: STAGE_ORDER → progress ASC → алфавит, устойчив к перетасовке входа
  const ordered = filterWords(deck, '', null)
  const expectedStageOrder = ordered.map(v => STAGE_ORDER.indexOf(wordStatus(v).stage))
  const sortedCheck = [...expectedStageOrder]
  for (let i = 1; i < sortedCheck.length; i++) {
    assert(sortedCheck[i - 1] <= sortedCheck[i], 'результат обязан идти по возрастанию индекса STAGE_ORDER')
  }
  // Deter и Zephyr — оба mature; сравним порядок по progress, затем по алфавиту
  const matureWords = ordered.filter(v => wordStatus(v).stage === 'mature')
  for (let i = 1; i < matureWords.length; i++) {
    const pa = wordStatus(matureWords[i - 1]).progress
    const pb = wordStatus(matureWords[i]).progress
    assert(pa < pb || (pa === pb && matureWords[i - 1].word.localeCompare(matureWords[i].word) <= 0),
      'внутри одной стадии порядок обязан идти по progress ASC, при равенстве — по алфавиту')
  }

  const shuffled = [...deck].reverse()
  const orderedFromShuffled = filterWords(shuffled, '', null).map(v => v.word)
  assert(orderedFromShuffled.join(',') === ordered.map(v => v.word).join(','),
    'порядок результата не должен зависеть от порядка карточек на входе')

  group('filterWords: поиск по слову и значению, фильтр по стадии, устойчивый порядок STAGE_ORDER→progress→алфавит')
}

function nonVocabExcludedChecks(): void {
  const deck: CardView[] = [
    exercise('mathex', fsrsCard({ state: State.Review, stability: 21, reps: 5 }), 'math'),
    exercise('grammarex', fsrsCard({ state: State.Review, stability: 21, reps: 5 }), 'grammar'),
    exercise('errorex', fsrsCard({ state: State.New, stability: 0, reps: 0 }), 'error')
  ]
  assert(stageCounts(deck).every(c => c.n === 0), 'stageCounts не должен учитывать несловарные карточки')
  assert(filterWords(deck, '', null).length === 0, 'filterWords не должен возвращать несловарные карточки')
  group('несловарные карточки (математика, грамматика, разборы) не участвуют в списке и в счётчиках')
}

function stageLabelChecks(): void {
  for (const s of STAGE_ORDER) assert(typeof STAGE_LABEL[s] === 'string' && STAGE_LABEL[s].length > 0, `у стадии ${s} обязана быть подпись`)
  const expected: Record<WordStage, string> = {
    leech: 'застряло', learning: 'знакомлюсь', review: 'помню', mature: 'закрепилось', new: 'не введено', suspended: 'отложено'
  }
  for (const s of STAGE_ORDER) assert(STAGE_LABEL[s] === expected[s], `подпись стадии ${s} обязана быть «${expected[s]}», получено «${STAGE_LABEL[s]}»`)
  group('STAGE_LABEL: подписи заданы для всех стадий и совпадают с ожидаемыми')
}

// ---- структура экрана WordList.tsx (текст исходника, без React/DOM) --------

/**
 * Проверки читают исходник `src/screens/WordList.tsx` текстом (см. `screenSource`) —
 * живой рендер в node недоступен. Задача этих проверок узкая и конкретная: не дать
 * экрану завести вторую версию правил стадии слова рядом с `wordstatus.ts`.
 */
function wordListScreenChecks(): void {
  const src = screenSource('WordList.tsx')

  assert(src.includes('filterWords('), 'экран обязан звать filterWords — отбор идёт через общий модуль, а не переписан на месте')
  assert(src.includes('stageCounts('), 'экран обязан звать stageCounts — счётчики идут через общий модуль')

  // самостоятельного вычисления стадии на экране быть не должно: это второй источник правды
  assert(!src.includes('MATURE_STABILITY_DAYS'), 'экран не должен знать порог зрелости — это дело wordstatus.ts')
  assert(!src.includes('LEECH_REPS'), 'экран не должен знать порог пиявки — это дело wordstatus.ts/metrics.ts')
  assert(!/fsrs\.state\s*===/.test(src), 'экран не должен сравнивать fsrs.state напрямую — стадия только через wordStatus()')

  // подписи стадий — только из STAGE_LABEL, не вписаны строками на месте
  for (const literal of ['закрепилось', 'застряло', 'знакомлюсь']) {
    assert(!src.includes(`'${literal}'`), `подпись стадии «${literal}» обязана браться из STAGE_LABEL, а не быть литералом в экране`)
  }

  assert(/aria-label=\{?["'`]/.test(src) || src.includes('aria-label='), 'у кнопки возврата обязан быть aria-label')
  assert(src.includes('aria-label="Назад"'), 'кнопка возврата обязана иметь aria-label="Назад" (тот же текст, что на остальных экранах)')
  // поле поиска подписано либо через <label>, либо через aria-label
  assert(/<label[^>]*>Поиск<\/label>|aria-label=["'`]Поиск/.test(src), 'у поля поиска обязана быть подпись (label) или aria-label')

  group('WordList.tsx: отбор и счётчики идут через wordstatus.ts, подписи из STAGE_LABEL, есть aria-label')
}

/** Вход на экран с главной - кнопка `setScreen('words')` в Home.tsx. */
function homeHasWordsEntryChecks(): void {
  const src = screenSource('Home.tsx')
  assert(src.includes("setScreen('words')"), 'Home.tsx обязан содержать переход на экран списка слов (setScreen(\'words\'))')
  group('Home.tsx: вход на экран списка слов существует')
}

/**
 * Структура главного экрана: порядок блоков разделов дня обязан идти из `dayplan.ts`
 * (WS6b), а не быть вписан на экране числами. Задача та же, что у `wordListScreenChecks`
 * выше - не дать экрану завести вторую версию правил рядом с общим модулем.
 */
function homeUsesDayplanChecks(): void {
  const src = screenSource('Home.tsx')

  assert(src.includes("from '../lib/dayplan'"), 'Home.tsx обязан импортировать план дня из lib/dayplan')
  assert(src.includes('sectionOrder(') || src.includes('nextSection('),
    'порядок блоков раздела обязан браться из dayplan.ts (sectionOrder/nextSection), а не вычисляться на экране')

  // веса RW (RW_WEIGHTS в dayplan.ts) не должны быть задублированы литералом на экране
  for (const literal of ['13/54', '26/54', '12/54']) {
    assert(!src.includes(literal), `вес раздела «${literal}» обязан жить в RW_WEIGHTS (dayplan.ts), а не литералом в экране`)
  }

  // норма ввода по разделу (NEW_PER_DAY_BY_SECTION/newPerDay в norms.ts) не должна читаться напрямую из старой общей нормы
  assert(!src.includes('NEW_PER_DAY.norm'), 'Home.tsx не должен читать NEW_PER_DAY.norm - норма своя у раздела, см. newPerDay в norms.ts')
  assert(!src.includes('NEW_PER_DAY.max'), 'Home.tsx не должен читать NEW_PER_DAY.max - норма своя у раздела, см. newPerDay в norms.ts')

  group('Home.tsx: порядок блоков идёт из dayplan.ts, веса RW и общая норма NEW_PER_DAY не задублированы литералом')
}

/**
 * F53: подпись блока практики при полном ответе на банк обязана идти из `practiceSummaryLabel`
 * (lib/practice.ts), а не из собственного сравнения `left === 0` на экране - иначе экран снова
 * заявит «Все вопросы решены», когда среди отвеченных есть неверные (репро судьи: 5 вопросов,
 * все с попыткой, 2 верных).
 */
function homePracticeSummaryChecks(): void {
  const src = screenSource('Home.tsx')
  assert(src.includes('practiceSummaryLabel'), 'Home.tsx обязан брать подпись блока практики из practiceSummaryLabel (lib/practice.ts)')
  assert(!/'Все вопросы решены'\s*<\/>\s*:\s*`Практика/.test(src) || src.includes('summaryLabel'),
    'подпись «Все вопросы решены» обязана приходить из summaryLabel, а не быть безусловной веткой left === 0')
  group('Home.tsx: подпись блока практики при завершённом банке зависит от practiceSummaryLabel, а не только от left === 0')
}

/**
 * F60: пустой раздел (`c.total === 0`) обязан получать честный текст кнопки «Нет карточек»,
 * а не «Всё повторено»/«Максимум дня взят» - те подписи заявляют работу, которой не было,
 * рядом с `hero-sub`, честно говорящим «пока пусто».
 */
function homeEmptySectionButtonChecks(): void {
  const src = screenSource('Home.tsx')
  assert(src.includes('c.total === 0'), 'кнопка раздела обязана явно проверять пустой раздел (c.total === 0)')
  assert(src.includes('Нет карточек'), 'пустой раздел обязан показывать «Нет карточек», а не «Всё повторено»')
  group('Home.tsx: кнопка пустого раздела показывает «Нет карточек», а не «Всё повторено»')
}

/**
 * D7 (06.09.2026): «отстаёшь на N дн» - отменённая формулировка (та же ошибка, что
 * «400 готовых слов» 17.08.2026, см. комментарий у capacityEstimate в metrics.ts).
 * Главное число экранов и отчёта - готовность к экзамену/измеренная ёмкость, а не
 * дефицит темпа в днях. `report.ts` не экран - читаем его тем же способом, что
 * `screenSource` читает экраны (текстом, из src/lib), а не через собственный формат.
 */
function noDaysBehindWordingChecks(): void {
  const reportSrc = readFileSync(path.join(process.cwd(), 'src', 'lib', 'report.ts'), 'utf8').replace(/\r\n/g, '\n')
  const statsSrc = screenSource('Stats.tsx')
  const homeSrc = screenSource('Home.tsx')

  for (const [name, src] of [['report.ts', reportSrc], ['Stats.tsx', statsSrc], ['Home.tsx', homeSrc]] as const) {
    assert(!src.includes('отстаёшь на'), `${name}: формулировка «отстаёшь на» отменена (D7) - главное число теперь ёмкость/готовность, а не дефицит темпа`)
  }

  group('D7: «отстаёшь на» не встречается в report.ts, Stats.tsx и Home.tsx')
}

/**
 * K2/K3 (06.09.2026): после FixI (`correct: verdict === 'correct'`, store.ts) сырое поле
 * `correct` перестало отличать настоящий провал/попадание от опечатки, синонима и подсказанного
 * ввода - список ошибок тьютору и «Закрытие пробелов» обязаны решать по `isKnowledgeMiss`/
 * `isKnowledgePass` (journal.ts), а не по `l.correct` напрямую, иначе опечатка и синоним снова
 * читаются как пробел в знании, а подсказка - как его закрытие.
 */
function reportKnowledgePredicateChecks(): void {
  const reportSrc = readFileSync(path.join(process.cwd(), 'src', 'lib', 'report.ts'), 'utf8').replace(/\r\n/g, '\n')
  assert(reportSrc.includes('isKnowledgeMiss') && reportSrc.includes('isKnowledgePass'),
    'report.ts обязан импортировать и использовать isKnowledgeMiss/isKnowledgePass из journal.ts')
  assert(!reportSrc.includes('l.correct !== false'),
    'report.ts: список ошибок тьютору не должен решаться сырым l.correct !== false (K2)')
  assert(!/l\.correct === true \|\| \(l\.correct === undefined/.test(reportSrc),
    'report.ts: «Закрытие пробелов» не должно решаться сырым l.correct === true (K3)')
  group('K2/K3: report.ts решает ошибку знания и закрытие пробела через isKnowledgeMiss/isKnowledgePass, не через сырой correct')
}

/**
 * WS5b (часть 2): структура экранов цели захода - счётчик "N из goal" и закрывающий показ
 * B7 в Review.tsx, кнопка "Ещё заход" на Summary.tsx, цена захода в минутах на Home.tsx.
 * Как и `wordListScreenChecks` выше, эти проверки читают исходник текстом (screenSource) -
 * живого рендера в node нет, а закрепить, что правки не срежут одну из веток выхода или
 * подпись, всё равно нужно.
 */
function sessionGoalScreenChecks(): void {
  const reviewSrc = screenSource('Review.tsx')
  const closingCalls = reviewSrc.split('tryClosing()').length - 1
  assert(closingCalls >= 2, 'Review.tsx обязан звать tryClosing() минимум в двух местах - обе ветки выхода (пустая очередь и крестик)')
  assert(reviewSrc.includes('лёгкое на прощание'), 'Review.tsx обязан показывать подпись «лёгкое на прощание» у закрывающего показа B7')
  assert(reviewSrc.includes('из ${goal}'), 'Review.tsx обязан считать счётчик дня по шаблону «N из ${goal}»')

  const summarySrc = screenSource('Summary.tsx')
  assert(summarySrc.includes('goalReached'), 'Summary.tsx обязан решать по r.goalReached, показывать ли «заход закрыт»')
  assert(summarySrc.includes('Ещё заход'), 'Summary.tsx обязан предлагать кнопку «Ещё заход» при достигнутой цели')
  // вторая дверь в урок заперта тем же замком, что и кнопка раздела на главной (due === 0)
  assert(/homeCounts\(sectionCards/.test(summarySrc) && /goalReached && moreAvail \?/.test(summarySrc),
    'Summary.tsx обязан показывать «Ещё заход» только когда разделу есть что выдать (homeCounts по разделу сессии, как SectionBlock на Home)')
  // B7: закрывающий показ строго один за сессию - флаг closingUsed ставится в tryClosing и проверяется на входе
  assert(/if \(closingUsed\.current/.test(reviewSrc) && (reviewSrc.match(/closingUsed\.current = true/g) ?? []).length === 1
    && !/closingUsed\.current = false/.test(reviewSrc),
    'Review.tsx: closingUsed обязан проверяться на входе tryClosing, ставиться ровно один раз и никогда не сбрасываться')
  assert(summarySrc.includes('До цели ещё'), 'Summary.tsx обязан показывать «До цели ещё K», когда цель не достигнута, а очередь не пуста')

  const homeSrc = screenSource('Home.tsx')
  assert(homeSrc.includes('speedStats('), 'Home.tsx обязан звать speedStats (lib/metrics.ts) для цены захода в минутах')
  assert(/RUN_MIN_REVIEWS[\s\S]{0,200}мин/.test(homeSrc), 'Home.tsx обязан показывать «мин» рядом с RUN_MIN_REVIEWS - цену захода')

  group('WS5b: счётчик «N из goal» и закрывающий показ B7 в Review.tsx, «Ещё заход»/«До цели ещё» в Summary.tsx, цена захода в минутах на Home.tsx')
}

/**
 * L1 (06.09.2026): списание бюджета окон знакомства (`reintroShown`/`freshIntros`) обязано
 * идти только внутри `commitIntroBudget` - локального helper в `grade` - и вызываться только
 * ПОСЛЕ успешной записи, а не до неё. Раньше списание стояло до `rateItem`/`markIntroduced`,
 * и повторное «Дальше» после ошибки записи списывало бюджет второй раз (см. SKILL.md).
 * Читаем исходник текстом тем же способом, что и `wordListScreenChecks` выше.
 */
function reviewIntroBudgetChecks(): void {
  const src = screenSource('Review.tsx')

  assert(src.includes('commitIntroBudget'), 'Review.tsx обязан содержать helper commitIntroBudget')

  // инкременты бюджета встречаются РОВНО там, где определён helper - нигде больше в файле
  const reintroIncrements = (src.match(/reintroShown\.current\+\+/g) ?? []).length
  const freshIncrements = (src.match(/freshIntros\.current\+\+/g) ?? []).length
  assert(reintroIncrements === 1, `reintroShown.current++ обязан встречаться ровно один раз (внутри commitIntroBudget), найдено ${reintroIncrements}`)
  assert(freshIncrements === 1, `freshIntros.current++ обязан встречаться ровно один раз (внутри commitIntroBudget), найдено ${freshIncrements}`)

  const helperStart = src.indexOf('commitIntroBudget = ')
  assert(helperStart >= 0, 'Review.tsx обязан определять commitIntroBudget как функцию')
  const helperEnd = src.indexOf('}', src.indexOf('}', helperStart) + 1)
  const helperBody = src.slice(helperStart, helperEnd)
  assert(helperBody.includes('reintroShown.current++') && helperBody.includes('freshIntros.current++'),
    'оба инкремента бюджета обязаны стоять внутри тела commitIntroBudget')

  // вызовы helper стоят ПОСЛЕ await rateItem( и ПОСЛЕ await markIntroduced( по позиции в файле
  const rateItemPos = src.indexOf('await rateItem(')
  const markIntroducedPos = src.indexOf('await markIntroduced(')
  const callPositions = [...src.matchAll(/commitIntroBudget\?\.\(\)/g)].map(m => m.index ?? -1)
  assert(rateItemPos >= 0 && markIntroducedPos >= 0, 'Review.tsx обязан звать rateItem и markIntroduced')
  assert(callPositions.some(p => p > markIntroducedPos && p < rateItemPos),
    'commitIntroBudget обязан вызываться после await markIntroduced( и до общей ветки rateItem')
  assert(callPositions.some(p => p > rateItemPos), 'commitIntroBudget обязан вызываться после await rateItem(')

  // L2: cued растёт ровно там, где известен вердикт после успешной записи
  assert(/verdict === 'cued'\)\s*r\.cued/.test(src) || /if \(verdict === 'cued'\)/.test(src),
    'res.current.cued обязан инкрементироваться при verdict === \'cued\'')

  group('L1/L2: списание бюджета окон только внутри commitIntroBudget после записи, cued растёт по verdict')
}

/**
 * Раздел «Логика» на экранах (09.09.2026). Ядро одноразовой модели проверяет набор `logic`,
 * здесь - её подключение к UI, тем же чтением исходника текстом, что и проверки выше.
 *
 * Стеречь надо ровно две вещи, и обе ломаются молча.
 * 1. Ни один путь Review.tsx не ведёт вопрос логики в `rateItem`: FSRS-блок такой карточки
 *    заморожен навсегда, и одна оценка вернула бы вопрос «по графику», которого нет.
 * 2. Журнал доходит до каждого счётчика раздела (`buildQueue`, `homeCounts`, `logicCounts`,
 *    `maturityBySection`): без него состояние логики невидимо, все вопросы выглядят свежими,
 *    и разобранное сегодня возвращается и в очередь, и в плашку главной.
 */
function logicScreenChecks(): void {
  const reviewSrc = screenSource('Review.tsx')

  // ветка раздела: своя запись вместо оценки, и она стоит ДО общей ветки rateItem
  assert(reviewSrc.includes('logLogicAnswer('), 'Review.tsx обязан писать ответ логики через logLogicAnswer (store.ts), а не через rateItem')
  const guard = reviewSrc.indexOf('if (isLogicCard(task.item.view))')
  const rateItemPos = reviewSrc.indexOf('await rateItem(')
  assert(guard >= 0, 'Review.tsx обязан перехватывать карточку логики проверкой isLogicCard в grade()')
  assert(rateItemPos >= 0 && guard < rateItemPos, 'перехват isLogicCard обязан стоять до общей ветки rateItem, иначе вопрос логики уйдёт в FSRS')

  // тело gradeLogic не зовёт ни rateItem, ни markIntroduced, ни deferItemToNextDay
  const start = reviewSrc.indexOf('async function gradeLogic()')
  assert(start >= 0, 'Review.tsx обязан содержать gradeLogic - единственную запись раздела «Логика»')
  const body = reviewSrc.slice(start, reviewSrc.indexOf('async function grade(', start))
  for (const запрещено of ['rateItem(', 'markIntroduced(', 'deferItemToNextDay(']) {
    assert(!body.includes(запрещено), `gradeLogic не имеет права звать ${запрещено}: FSRS раздела «Логика» не двигается вовсе`)
  }
  assert(body.includes('logLogicAnswer('), 'gradeLogic обязан писать строку журнала через logLogicAnswer')
  // B7: закрывающий показ разделу не положен - lastGrade из gradeLogic не выставляется
  assert(!body.includes('lastGrade.current ='), 'gradeLogic не выставляет lastGrade: закрывающий показ B7 к логике не применяется')

  // store.ts строит строку чистой logicReviewLine, а не собирает поля заново
  const storeSrc = readFileSync(path.join(process.cwd(), 'src', 'lib', 'store.ts'), 'utf8').replace(/\r\n/g, '\n')
  const storeStart = storeSrc.indexOf('export async function logLogicAnswer(')
  assert(storeStart >= 0, 'store.ts обязан экспортировать logLogicAnswer')
  const rateStart = storeSrc.indexOf('export async function rateItem(')
  const rateHead = storeSrc.slice(rateStart, storeSrc.indexOf('makeScheduler(', rateStart))
  assert(rateStart >= 0 && /if \(isLogicCard\(item\.view\)\) throw/.test(rateHead),
    'rateItem обязан отвергать карточку логики до вызова планировщика: замок должен стоять в слое данных, а не только в Review.tsx')
  const storeBody = storeSrc.slice(storeStart, storeStart + 700)
  assert(storeBody.includes('logicReviewLine('), 'logLogicAnswer обязан строить строку журнала через logicReviewLine (lib/logic.ts)')
  assert(!storeBody.includes('putCardAndJournal'), 'logLogicAnswer не имеет права писать карточку: fsrs-блока у логики больше нет')

  // одна кнопка выхода вместо ряда оценок, и та же кнопка на Enter/пробел
  assert(reviewSrc.includes('const isLogic = isLogicCard(card)'), 'Review.tsx обязан вычислять isLogic для разметки листа')
  assert(reviewSrc.includes('{isLogic ?'), 'лист ответа обязан ветвиться по isLogic - у логики нет ряда Again/Hard/Good/Easy')
  assert(/onClick=\{\(\) => void gradeLogic\(\)\}>Дальше</.test(reviewSrc), 'ветка логики обязана давать одну кнопку «Дальше», зовущую gradeLogic')
  assert(/revealed && isLogicCard\(task\.item\.view\)\) void gradeLogic\(\)/.test(reviewSrc),
    'Enter/пробел на разобранном вопросе логики обязаны работать как «Дальше»')

  // очередь урока строится по журналу (седьмой аргумент buildQueue)
  assert(/buildQueue\([^\n]*corpusHitsBySlug, currentJournal\(\)\)/.test(reviewSrc),
    'Review.tsx обязан звать buildQueue с журналом (седьмой аргумент) - иначе решённые вопросы логики вернутся в очередь')

  // журнал доходит до всех счётчиков главной, итогов и статистики
  const homeSrc = screenSource('Home.tsx')
  const summarySrc = screenSource('Summary.tsx')
  const statsSrc = screenSource('Stats.tsx')
  const mainSrc = readFileSync(path.join(process.cwd(), 'src', 'main.tsx'), 'utf8').replace(/\r\n/g, '\n')
  for (const [name, src] of [['Home.tsx', homeSrc], ['Summary.tsx', summarySrc], ['Stats.tsx', statsSrc], ['main.tsx', mainSrc]] as const) {
    // вызов без единой вложенной скобки - это вызов из двух простых аргументов, то есть без журнала
    const bare = src.match(/homeCounts\([^()]*\)/g) ?? []
    assert(bare.length === 0, `${name}: homeCounts обязан зваться с журналом (четвёртый аргумент), найдено «${bare[0]}»`)
    // journal / app.journal / currentJournal() - три живых способа передать один и тот же журнал
    assert(/homeCounts\([^\n]*[Jj]ournal(\(\))?\)/.test(src), `${name}: в вызове homeCounts обязан стоять журнал`)
  }
  assert(/maturityBySection\(all, app\.journal\)/.test(statsSrc),
    'Stats.tsx: maturityBySection обязан получать журнал - зрелость логики меряется им, а не fsrs')

  // плашка раздела: три своих числа и своя кнопка
  assert(/logicCounts\(cards, journal/.test(homeSrc), 'Home.tsx обязан считать плашку логики через logicCounts (lib/logic.ts)')
  assert(homeSrc.includes('journal={app.journal}') && homeSrc.includes('section={s}'),
    'SectionBlock обязан получать раздел и журнал: без них плашка логики считалась бы по FSRS')
  for (const подпись of ['осталось', 'разобрано', 'ошибок', 'Разбирать']) {
    assert(homeSrc.includes(подпись), `Home.tsx: плашка логики обязана показывать «${подпись}»`)
  }
  assert(/disabled=\{lg\.avail === 0\}/.test(homeSrc), 'кнопка «Разбирать» обязана запираться при avail === 0')

  group('Логика на экранах: Review не зовёт rateItem, очередь и счётчики считаются по журналу, плашка «Разбирать»')
}

/**
 * other_senses (09.09.2026): остальные значения слова помимо основного (meaning_en/meaning_ru).
 * Показ обязан стоять в ОБЕИХ ветках карточки - окно-знакомство (intro) и раскрытие после
 * ответа (reveal) - иначе половина показов слова молчит об остальных значениях. Проверка
 * читает исходник текстом (screenSource), как и остальные структурные проверки этого файла.
 */
/**
 * T6: ротация значений слова. Показ «Ещё значения» в обеих ветках карточки (intro и reveal)
 * обязан идти через senseDisplay (src/lib/senses.ts) - единый источник asked/rest, а не через
 * прямой перебор card.other_senses: иначе после ответа список показывал бы ВСЕ значения
 * подряд, не отличая спрошенное (asked) от остальных (rest), и рассинхронизировался бы с
 * реально проверенным значением при ротации.
 */
function otherSensesScreenChecks(): void {
  const src = screenSource('Review.tsx')

  assert(src.includes('senseDisplay('), 'Review.tsx обязан строить «Ещё значения» через senseDisplay')
  assert(!src.includes('card.other_senses'),
    'Review.tsx не обязан больше перебирать card.other_senses напрямую - senseDisplay уже отдаёт полный список (T6)')

  const sensesBlocks = (src.match(/className="rev-senses"/g) ?? []).length
  assert(sensesBlocks === 2, `Review.tsx обязан показывать блок .rev-senses ровно в двух ветках (intro и reveal), найдено ${sensesBlocks}`)

  const restBlocks = (src.match(/display\.rest\.map/g) ?? []).length
  assert(restBlocks === 2, `оба блока .rev-senses обязаны рендерить display.rest, найдено ${restBlocks}`)

  assert(src.includes('rev-sense-asked'),
    'спрошенное значение (не главное) обязано быть помечено отдельным классом rev-sense-asked')
  assert(src.includes("task.sense > 0 ? ' rev-sense-asked' : ''"),
    'класс rev-sense-asked обязан ставиться по task.sense, а не безусловно (иначе главное значение тоже красилось бы)')

  group('other_senses: показ «Ещё значения» в обеих ветках (intro и reveal) идёт через senseDisplay, спрошенное значение помечено rev-sense-asked')
}

function main(): void {
  console.log('SRS wordstatus - единый источник правды о состоянии слова')
  agreementWithHomeChecks()
  prepLeechDivergenceChecks()
  stageByStageChecks()
  suspendedBeatsAllChecks()
  leechChecks()
  progressChecks()
  stageCountsChecks()
  filterWordsChecks()
  nonVocabExcludedChecks()
  stageLabelChecks()
  wordListScreenChecks()
  homeHasWordsEntryChecks()
  homeUsesDayplanChecks()
  homePracticeSummaryChecks()
  homeEmptySectionButtonChecks()
  noDaysBehindWordingChecks()
  reportKnowledgePredicateChecks()
  sessionGoalScreenChecks()
  reviewIntroBudgetChecks()
  logicScreenChecks()
  otherSensesScreenChecks()
  console.log(`\nВсе проверки статуса слова пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ WORDLIST УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
