/**
 * Тесты плана дриллов знакомства (src/lib/drill.ts, правило A12).
 *
 * Жалоба ученика: новое слово показывается один раз и пропадает. После знакомства (`intro`)
 * слово получало одну отработку, уходило на 10-минутную ступень FSRS, а вернуть его в тот же
 * урок сроком (`requeuePosition`/`shouldRequeue`, scheduler.ts) не получалось - для этого
 * нужно порядка тридцати карточек в остатке очереди, а на тонкой колоде их нет. Правило A12
 * даёт слову ВТОРОЙ путь возврата в урок, не завязанный на срок FSRS: не меньше DRILL_REPS
 * оценённых отработок сразу, план которых живёт в самой единице очереди (`StudyItem.drill`).
 *
 * Запуск: `npm run test:drill` (esbuild бандлит файл и node его исполняет).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createEmptyCard, Rating, State } from 'ts-fsrs'
import type { CardView, StudyItem } from '../src/lib/types'
import { NEW_GAP, buildQueue, pickTask } from '../src/lib/scheduler'
import { DRILL_GAP, DRILL_REPS, afterDrill, drillInsertAt, drillLine, drillTask, isDrillable, startsDrillPlan } from '../src/lib/drill'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

const BASE = new Date('2026-09-10T10:00:00+04:00')

/** Карточка-заготовка (тот же минимум полей CardView, что в dayplan.test.ts/session-sim). */
function makeCard(slug: string, o: Partial<CardView> = {}): CardView {
  return {
    path: `deck/${slug}.md`, slug, word: slug, pos: 'noun',
    context: `___ ${slug}`, contexts: [`___ ${slug}`], contextsRu: [],
    meaning_en: `meaning ${slug}`, meaning_ru: `${slug} по-русски`, roots: '',
    source: 'test', added: '2026-01-01', level: 1, kind: 'vocab', domain: '',
    confusables: [], synonyms: [], other_senses: [], from_mark: [], leech: '', choices: [], answerText: '', answerNum: '',
    desmos: false, explain: '', suspended: false,
    fsrs: createEmptyCard(BASE),
    prep: '', prepContext: '', fsrsPrep: null,
    ...o
  }
}

function item(view: CardView, o: Partial<StudyItem> = {}): StudyItem {
  return { view, skill: 'recall', fsrs: view.fsrs, ...o }
}

function reviewCard(slug: string, dueOffsetMs: number): CardView {
  return makeCard(slug, {
    fsrs: { ...createEmptyCard(BASE), state: State.Review, due: new Date(BASE.getTime() + dueOffsetMs), stability: 5, reps: 3, last_review: BASE } as CardView['fsrs']
  })
}

// ---- DRILL_GAP синхронен с NEW_GAP (A12: разрыв дрилла - тот же порядок, что у A3) --------

function drillGapSyncedWithNewGap(): void {
  assert(DRILL_GAP === NEW_GAP + 1, `DRILL_GAP обязан равняться NEW_GAP + 1 (${NEW_GAP} + 1), получено ${DRILL_GAP}`)
  group('DRILL_GAP === NEW_GAP + 1 (литерал в drill.ts синхронен с NEW_GAP из scheduler.ts)')
}

// ---- isDrillable / startsDrillPlan -----------------------------------------------------

function startsDrillPlanTable(): void {
  const vocabNew = item(makeCard('vocab-new'))
  assert(startsDrillPlan(vocabNew, State.New, 'mc') === true, 'New + mc (не intro) обязан открывать план дриллов')
  assert(startsDrillPlan(vocabNew, State.New, 'intro') === false, 'New + intro (само знакомство) плана не открывает')
  assert(startsDrillPlan(vocabNew, State.Learning, 'mc') === false, 'Learning (не первая отработка) плана не открывает')

  const prepItem = item(makeCard('vocab-prep'), { skill: 'prep' })
  assert(startsDrillPlan(prepItem, State.New, 'prep') === false, 'навык prep дриллы не получает - isDrillable требует recall')

  const errorItem = item(makeCard('log-a', { kind: 'error', domain: 'II' }))
  assert(startsDrillPlan(errorItem, State.New, 'mc') === false, 'логика (kind error) дриллы не получает - только vocab')

  assert(isDrillable(vocabNew) === true, 'recall + vocab - тот же срез, что isDrillable должен пропускать')
  assert(isDrillable(errorItem) === false, 'kind !== vocab не проходит isDrillable')
  assert(isDrillable(prepItem) === false, 'skill !== recall не проходит isDrillable')
  group('startsDrillPlan/isDrillable: New+mc -> true, New+intro -> false, Learning -> false, prep/логика -> false')
}

// ---- afterDrill --------------------------------------------------------------------------

function afterDrillTable(): void {
  const base = item(makeCard('afterdrill-word'))
  const first = afterDrill(base, Rating.Good)
  assert(first !== null && first.drill === 1, `единица без drill обязана получить drill:1 после первой отработки, получено ${JSON.stringify(first)}`)

  const onGood = afterDrill({ ...base, drill: 1 }, Rating.Good)
  assert(onGood !== null && onGood.drill === 2, `1 + Good обязан дать drill:2, получено ${JSON.stringify(onGood)}`)

  const finished = afterDrill({ ...base, drill: 2 }, Rating.Good)
  assert(finished === null, `2 + Good обязан закрыть план (null, DRILL_REPS=${DRILL_REPS}), получено ${JSON.stringify(finished)}`)

  const onAgain = afterDrill({ ...base, drill: 1 }, Rating.Again)
  assert(onAgain !== null && onAgain.drill === 1, `1 + Again обязан оставить ту же ступень (drill:1 - окно «Подзабылось» уже отработало провал), получено ${JSON.stringify(onAgain)}`)

  const firstOnAgain = afterDrill(base, Rating.Again)
  assert(firstOnAgain !== null && firstOnAgain.drill === 1, 'без drill план открывается ступенью 1 независимо от оценки первой отработки')

  group('afterDrill: без drill -> 1, 1+Good -> 2, 2+Good -> null, 1+Again -> 1')
}

// ---- drillInsertAt -------------------------------------------------------------------------

function drillInsertAtTable(): void {
  assert(drillInsertAt(0) === 0, 'пустой остаток - вставлять некуда, 0')
  assert(drillInsertAt(2) === 2, 'остаток короче DRILL_GAP - вставляем в конец остатка')
  assert(drillInsertAt(10) === DRILL_GAP, `остаток длиннее DRILL_GAP - вставляем через DRILL_GAP (${DRILL_GAP}) позиций`)
  group('drillInsertAt: 0 -> 0, 2 -> 2, 10 -> DRILL_GAP(3)')
}

// ---- drillTask -------------------------------------------------------------------------

function drillTaskWithDistractors(): void {
  const target = makeCard('target-word', { pos: 'noun', meaning_ru: 'значение', level: 1 })
  // соседи той же части речи и уровня - дают и mcDistractors, и meaningDistractors по три
  const neighbours = Array.from({ length: 5 }, (_, i) => makeCard(`neighbour-${i}`, { pos: 'noun', meaning_ru: `соседнее значение ${i}`, level: 1 }))
  const deck = [target, ...neighbours]

  const first = drillTask(item(target, { drill: 1 }), deck, true)
  assert(first.format === 'mc' && first.cue === 'sentence', `дрилл 1 при трёх дистракторах обязан быть mc/sentence, получено ${JSON.stringify(first)}`)

  const second = drillTask(item(target, { drill: 2 }), deck, true)
  assert(second.format === 'type' && second.cue === 'meaning', `дрилл 2 при typing и однозначном ответе обязан быть type/meaning, получено ${JSON.stringify(second)}`)

  const secondNoTyping = drillTask(item(target, { drill: 2 }), deck, false)
  assert(secondNoTyping.format === 'mc' && secondNoTyping.cue === 'word', `дрилл 2 без ввода при трёх дистракторах значения обязан откатиться на mc/word, получено ${JSON.stringify(secondNoTyping)}`)

  group('drillTask (дистракторы есть): дрилл 1 -> mc/sentence, дрилл 2 -> type/meaning (typing) или mc/word (без typing)')
}

function drillTaskWithoutDistractors(): void {
  // слово в одиночестве в своём разделе - ни mc-, ни meaning-дистракторов набрать неоткуда
  const lonely = makeCard('lonely-word', { pos: 'noun', meaning_ru: 'значение', level: 1 })
  const deck = [lonely]

  const first = drillTask(item(lonely, { drill: 1 }), deck, true)
  assert(first.format === 'reveal' && first.cue === 'sentence', `дрилл 1 без дистракторов обязан откатиться на reveal/sentence, получено ${JSON.stringify(first)}`)

  const second = drillTask(item(lonely, { drill: 2 }), deck, false)
  assert(second.format === 'reveal' && second.cue === 'sentence', `дрилл 2 без typing и без дистракторов обязан откатиться на reveal/sentence, получено ${JSON.stringify(second)}`)

  group('drillTask (дистракторов нет): дрилл 1 и дрилл 2 откатываются на reveal/sentence')
}

// ---- drillLine ------------------------------------------------------------------------

function drillLineChecks(): void {
  const view = makeCard('drill-line-word', { meaning_ru: 'значение' })
  const learning = item(view, { drill: 1, fsrs: { ...view.fsrs, state: State.Learning, reps: 1 } as CardView['fsrs'] })
  const line = drillLine(learning, Rating.Good, 4000, 'mc', BASE, 'correct', false, 3500)

  assert(line.type === 'review', 'строка дрилла - review, как обычная оценка')
  assert(line.format === 'mc', 'формат строки - тот, что был реально показан')
  assert(line.rating === Rating.Good, 'оценка дрилла пишется как есть')
  assert(line.drill === 1, 'номер дрилла обязан попасть в строку')
  assert(line.prev_state === State.Learning, 'prev_state - ТЕКУЩЕЕ состояние карточки (дрилл его не двигал)')
  assert(line.correct === true, 'вердикт correct переносится в поле correct')
  assert('new_state' in line === false, 'у строки дрилла НЕ должно быть new_state - FSRS не двигался')
  assert('due' in line === false, 'у строки дрилла НЕ должно быть due')
  assert('stability' in line === false, 'у строки дрилла НЕ должно быть stability')
  assert('scheduled_days' in line === false, 'у строки дрилла НЕ должно быть scheduled_days')
  assert('elapsed_days' in line === false, 'у строки дрилла НЕ должно быть elapsed_days')
  assert(typeof line.elapsed_ms === 'number', 'elapsed_ms обязан быть числом')
  assert(typeof line.answer_ms === 'number', 'answer_ms обязан присутствовать, когда передан answerMs')

  group('drillLine: содержит drill/rating/prev_state, не содержит new_state/due/stability/scheduled_days/elapsed_days')
}

// ---- buildQueue: резерв хвоста ----------------------------------------------------------

function buildQueueReserveSmallReviews(): void {
  // last_review = BASE (сегодня) - карточки исключены из разгона (warmupShows), иначе он
  // забирает у review до двух карточек и резерв считается уже не от того числа
  const reviews = Array.from({ length: 5 }, (_, i) => reviewCard(`rev-${i}`, -1000 * (5 - i)))
  const news = Array.from({ length: 10 }, (_, i) => makeCard(`new-${i}`))
  const q = buildQueue([...reviews, ...news], 10, BASE)

  const lastNewIdx = q.reduce((acc, it, idx) => it.fsrs.state === State.New ? idx : acc, -1)
  const reviewsAfter = q.slice(lastNewIdx + 1).filter(it => it.fsrs.state !== State.New).length
  assert(reviewsAfter === 3, `10 новых + 5 повторов: после последнего нового обязаны стоять три последних повтора, получено ${reviewsAfter}`)
  group('buildQueue резерв: 10 новых + 5 повторов - три последних повтора после последнего нового')
}

function buildQueueReserveLargeReviews(): void {
  const reviews = Array.from({ length: 30 }, (_, i) => reviewCard(`rev-${i}`, -1000 * (30 - i)))
  const news = Array.from({ length: 10 }, (_, i) => makeCard(`new-${i}`))
  const q = buildQueue([...reviews, ...news], 10, BASE)

  const positions = q.reduce<number[]>((acc, it, idx) => { if (it.fsrs.state === State.New) acc.push(idx); return acc }, [])
  assert(positions.length === 10, `в очереди обязано остаться 10 новых слов, получено ${positions.length}`)
  const stride = Math.max(NEW_GAP + 1, Math.round((30 + 10) / 10))
  for (let i = 0; i < 9; i++) {
    const expected = 1 + i * stride
    assert(positions[i] === expected, `при 30 повторах (>> DRILL_GAP) резерв не должен трогать первые девять новых - позиция ${i} обязана остаться 1 + i*stride = ${expected}, получено ${positions[i]}`)
  }
  group('buildQueue резерв: 30 повторов + 10 новых - позиции первых девяти новых не изменились относительно 1 + i*stride')
}

// ---- pickTask: план дриллов и провал -----------------------------------------------------

function pickTaskDrillBranch(): void {
  const view = makeCard('pick-drill-word', { meaning_ru: 'значение' })
  const learningState = { ...view.fsrs, state: State.Learning, reps: 1 } as CardView['fsrs']
  const drillItem: StudyItem = { view: { ...view, fsrs: learningState }, skill: 'recall', fsrs: learningState, drill: 1 }

  const lapsed = new Set([`${drillItem.view.path}#recall`])
  const onLapse = pickTask(drillItem, [view], undefined, lapsed, true, true, BASE)
  assert(onLapse.format === 'intro', `лапснутое слово с планом дриллов обязано получить intro (окно «Подзабылось») раньше дрилла, получено ${JSON.stringify(onLapse)}`)

  const withoutLapse = pickTask(drillItem, [view], undefined, undefined, true, true, BASE)
  const expected = drillTask(drillItem, [view], true)
  assert(withoutLapse.format === expected.format && withoutLapse.cue === expected.cue,
    `без провала pickTask обязан отдать формат дрилла (drillTask), получено ${JSON.stringify(withoutLapse)}, ожидалось ${JSON.stringify(expected)}`)

  group('pickTask: единица с drill и лапснутого слова -> intro, без лапса -> формат дрилла')
}

// ---- rateDrill (store.ts): дрилл не двигает FSRS-блок карточки ---------------------------

/** Тело `rateDrill` от объявления до следующего `export ` верхнего уровня после него. */
function rateDrillSource(): string {
  const src = readFileSync(path.join(process.cwd(), 'src', 'lib', 'store.ts'), 'utf8')
  const start = src.indexOf('export async function rateDrill')
  assert(start >= 0, 'store.ts обязан экспортировать rateDrill')
  // граница тела - закрывающая фигурная скобка САМОЙ функции (верхнего уровня, столбец 0),
  // а не первое вхождение "export": между функциями стоит JSDoc СЛЕДУЮЩЕЙ, и её текст
  // (описывающий, ЧЕГО она не делает) мог бы упомянуть те же слова, что мы запрещаем в rateDrill
  const end = src.indexOf('\n}', start)
  assert(end > start, 'у rateDrill обязана быть закрывающая скобка верхнего уровня (нашли конец тела по ней)')
  return src.slice(start, end)
}

function rateDrillDoesNotTouchFsrs(): void {
  const body = rateDrillSource()
  for (const forbidden of ['putCardAndJournal', 'fsrsToFm', 'dirty', 'first_seen']) {
    assert(!body.includes(forbidden), `rateDrill не должен трогать FSRS-блок карточки - найдено запрещённое "${forbidden}"`)
  }
  assert(body.includes('pushJournal'), 'rateDrill обязан писать журнал через pushJournal')
  assert(body.includes('drillLine'), 'rateDrill обязан строить строку журнала через drillLine')
  group('rateDrill (store.ts): не содержит putCardAndJournal/fsrsToFm/dirty/first_seen, содержит pushJournal и drillLine')
}

function main(): void {
  console.log('SRS drill: план дриллов знакомства (правило A12)')
  drillGapSyncedWithNewGap()
  startsDrillPlanTable()
  afterDrillTable()
  drillInsertAtTable()
  drillTaskWithDistractors()
  drillTaskWithoutDistractors()
  drillLineChecks()
  buildQueueReserveSmallReviews()
  buildQueueReserveLargeReviews()
  pickTaskDrillBranch()
  rateDrillDoesNotTouchFsrs()
  console.log(`\nВсе проверки плана дриллов пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ ПЛАНА ДРИЛЛОВ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
