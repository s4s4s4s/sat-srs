/**
 * Симуляция очереди сессии на моках — без PWA/IndexedDB/React. Гоняет РЕАЛЬНЫЕ функции
 * планировщика (buildQueue, pickFormat, earlyFillers) и выбора экрана (pickNext, hasSeparator,
 * screenFormat), воспроизводя цикл grade→advance→proceed из src/screens/Review.tsx.
 * Проверяет инвариант обучения (Учёба/Карточки/_правила-srs.md):
 *   A2 — между двумя показами одной карточки не меньше минуты;
 *   A3 — нет двух подряд идущих экранов одного слова;
 *   A4-bis — знакомств подряд не больше INTRO_BATCH_MAX;
 *   A6 — каждое показанное знакомство отработано в том же уроке (главный регресс-тест:
 *        25.07 знакомство показывалось и бросалось, и урок повторялся один в один);
 *   B4 — урок не заканчивается, пока сегодняшнее слово не отработано;
 *   C1 — type у введённого слова не раньше двух опознаний (reveal/mc);
 *   C2 — слово, дважды проваленное за сессию, из урока выбывает.
 *
 * Запуск: `npm test` (esbuild бандлит этот файл и node его исполняет).
 */
import { State, Rating, createEmptyCard, type Grade } from 'ts-fsrs'
import type { CardView, StudyItem, JournalLine } from '../src/lib/types'
import { DEFAULT_SETTINGS } from '../src/lib/types'
import {
  buildQueue, makeScheduler, itemKey, NEW_GAP, shouldRequeue, requeuePosition,
  pickFormat, mcDistractors, suggestedGrade, slowThresholdMs, medianForKind, SLOW_FACTOR, hasMeaningHint, earlyFillers, MAX_EARLY_FILLERS, MIN_SHOW_GAP_MS, holdOnIntroDay, holdExerciseToNextDay, isExercise, LEARN_AHEAD_MS, LAST_LEARNING_STEP, sharesMeaning, typedTwin, checkTyped,
  MIN_SHOW_GAP_FLOOR_MS, INTRO_GAP_MS, MAX_INTRO_BONUS, nextNewItems, nextCtxIndex, isSeenWord,
  pickTask, meaningDistractors, REVIEW_CYCLE, ROTATE_FROM_REPS, NEW_STOP_DATE, kindRank, expandItems, freshItems, markGlosses,
  NEW_STOP_BY_SECTION, newIntroAllowed, nextAttempt, lastAttempt, dueCap, phase, effectiveRetention, FINAL_RETENTION, PRIMARY_DATE, EXAM_DATE,
  homeCounts, sectionOf, SECTIONS, newBudgetFor, newBudgetTotal, type Section,
  MAX_REVIEW_PER_LESSON, MAX_REVIEW_PER_DAY, LEECH_QUARANTINE_DAYS, leechReturned, MAX_LEECH_PER_LESSON,
  WARMUP_SHOWS, warmupShows, CLOSING_SHOWS, closingShow, type TypeVerdict
} from '../src/lib/scheduler'
import { pickNext, hasSeparator, screenFormat, isGiveUp, objectiveOutcome, INTRO_BATCH_MAX, INTRO_GAP_FLOOR_MS, REINTRO_PER_LESSON, type OrderCtx } from '../src/lib/session'
import { screenSource } from './screen-source'
import { lessonProgress, estimateShowsLeft, DRILL_PER_SESSION, type ProgressInput } from '../src/lib/progress'
import { endOfStudyDay, dayKey, addDaysKey } from '../src/lib/daytime'
import { sessionAccuracy, matureRetention, forcedTodaySlugs, CARD_TIME_CAP_MS, liveMarkedLemmas } from '../src/lib/journal'
import { isLeech, LEECH_REPS, LEECH_STABILITY_DAYS, SECTION_LABELS, speedStats } from '../src/lib/metrics'
import { newPerDay } from '../src/lib/norms'
import { logicReviewLine, logicStatus, pickLogic } from '../src/lib/logic'

const BASE = new Date(2026, 6, 24, 10, 0, 0).getTime()
/** Целевая точность продукта, а не своя копия: расхождение с настройкой делало бы модель урока враньём */
const RETENTION = DEFAULT_SETTINGS.requestRetention
/** Секунд на экран: реальные показы 25.07 занимали 5–16 c, поэтому разрыв A2 действительно мешает */
const SCREEN_MS = 10_000

// ---- фабрики карточек ----------------------------------------------------

function baseView(word: string, level: number, kind: string): CardView {
  return {
    path: `deck/${word}.md`, slug: word, word, pos: 'adj',
    context: `The ___ moment defined ${word}.`,
    contexts: [`The ___ moment defined ${word}.`, `A second ___ line about ${word}.`],
    /* Глосс обязан быть РАЗНЫМ у разных слов — как в живой колоде. Раньше здесь стояло
       «значение ${word}», и главным словом у всех карточек оказывалось одно и то же
       «значение»: правило двойников (meaningTwin) объявляло синонимами всю фикстуру,
       выборка дистракторов оставалась без колоды и откатывалась на авторские варианты.
       Фикстура, в которой все слова значат одно, не моделирует колоду, а ломает то,
       что на ней проверяют. */
    meaning_en: `meaning of ${word}`, meaning_ru: `${word} по-русски`, roots: '',
    source: 'test', added: '2026-07-20', level, kind,
    domain: '', confusables: [], synonyms: [], other_senses: [], from_mark: [], leech: '', choices: [], answerText: '', answerNum: '',
    desmos: false, explain: '', suspended: false,
    fsrs: createEmptyCard(new Date(BASE)),
    prep: '', prepContext: '', fsrsPrep: null
  }
}

/** Новое слово (state New). */
function newCard(word: string, level = 1): CardView {
  return baseView(word, level, 'vocab')
}

/** Дозревшее до Review слово; dueOffsetMs < 0 — просрочка (в урок), > суток — только заполнитель. */
function reviewCard(word: string, level = 1, dueOffsetMs = -3600_000): CardView {
  const v = baseView(word, level, 'vocab')
  const f = makeScheduler(RETENTION)
  let c = v.fsrs
  let t = BASE - 12 * 86400_000
  for (let i = 0; i < 5 && c.state !== State.Review; i++) {
    c = f.next(c, new Date(t), Rating.Good).card
    t += 2 * 86400_000
  }
  v.fsrs = { ...c, due: new Date(BASE + dueOffsetMs) }
  return v
}

/** Повтор со сроком завтра (после rollover, но в пределах суток) — кандидат в заполнители B4. */
function tomorrowCard(word: string, level = 1): CardView {
  return reviewCard(word, level, 20 * 3600_000)
}

// ---- лог показов ---------------------------------------------------------

interface Show {
  path: string; format: string; skill: string; graded: Grade | null; at: number; key: string
  reps: number      // fsrs.reps на момент показа — по нему проверяется C1
  wasNew: boolean   // слово было New на момент показа (знакомство, а не «Подзабылось» зрелого слова)
  /* Экран выбран аварийным полом разрыва (последняя ступень лестницы B4). Без этого поля
     проверка A2 не отличала законный показ на тридцатой секунде от обычного показа раньше
     срока: она мерила ВСЕ показы полом и молчала там, где урок сокращал разрыв, имея
     чем его выдержать. */
  byFloor: boolean
}

interface DayOpts {
  budget: number
  introLimit: number
  failWords?: Set<string>
  lessons?: number
  /** дневная норма новых слов: считается НА ДЕНЬ, а не на урок (Review.tsx: dayNewLeft) */
  dayNew?: number
  /** секунд на экран: короткий экран приближает разрывы A2 и включает аварийный пол */
  screenMs?: number
  /** слаги, на знакомстве которых ученик жмёт «Уже знаю это слово» (Rating.Easy) */
  knownWords?: Set<string>
  /** WS5b: цель захода, зажимающая знаменатель полоски (ProgressInput.goal); по умолчанию
   *  Infinity - прежнее поведение симуляции, не зависящее от цели */
  goal?: number
}

/**
 * Кадр полоски прогресса — ровно то, что Review.tsx рисует в `.progress` в момент кадра.
 * `kind: 'skip'` — знакомство, которое урок показать не смог: кадр отрисовался, показа не было.
 * `est`, `word` и `queue` в проверках не участвуют: это расшифровка кадра для разбора
 * упавшего прогона (`BARDUMP=1 npm run test:session`), без неё падение полоски немое.
 */
interface Bar {
  kind: 'screen' | 'skip'
  /** Доля, нарисованная на экране, 0..1 — уже под храповиком. */
  pct: number
  /** Числитель: закрытых показов до этого кадра. */
  shown: number
  /** Знаменатель на этом кадре: показов всего по оценке. */
  est: number
  /** Что на экране: слово и формат. */
  word: string
  /** Очередь, добор и запасы лестницы на момент кадра. */
  queue: string
}

interface DayRun { lessons: Show[][]; bars: Bar[][] }

/**
 * Прогон учебного дня: несколько уроков подряд по одной колоде (состояние карточек мутирует,
 * как в store.rateItem). Зеркалит Review.tsx: тот же контекст выбора, те же обновления
 * introduced/lapsed/sinceIntro/freshIntros/reintroShown/batchIntros, та же лестница добора proceed
 * (очередь → недоработанные сегодняшние → заполнители → пауза A2 → конец урока).
 */
function runDay(deck: CardView[], opts: DayOpts): DayRun {
  const f = makeScheduler(RETENTION)
  const failWords = opts.failWords ?? new Set<string>()
  const lessonsN = opts.lessons ?? 1
  let now = BASE
  const lessons: Show[][] = []
  const allBars: Bar[][] = []
  const dayNew = opts.dayNew ?? 15
  const screenMs = opts.screenMs ?? SCREEN_MS
  const knownWords = opts.knownWords ?? new Set<string>()
  /* Слаги, получившие сегодня оценку из состояния New. Дневная норма живёт на ДЕНЬ, а не на
     урок: в приложении её считает newIntroducedOn по журналу, здесь - это множество.
     Без него второй урок дня начинал норму заново, и симуляция не видела бы перерасхода. */
  const ratedNewToday = new Set<string>()
  /* Упражнений (оценённых показов) за ДЕНЬ, а не за урок: ровно то, что Review.tsx рисует
     рядом с полоской как «N из цели» (baseUnits прошлых заходов плюс reviews текущего), и
     ровно то, чем цель зажимает знаменатель полоски (ProgressInput.doneToday). Окно-
     знакомство сюда не попадает: оценки оно не даёт (A7). */
  let unitsToday = 0
  // эмуляция forcedTodaySlugs: slug → { первый урок со знакомством, уроки с отработкой после него }
  const introAt = new Map<string, number>()
  const practiceAt = new Map<string, Set<number>>()
  const kindOf = new Map(deck.map(v => [v.slug, v.kind]))

  for (let lesson = 0; lesson < lessonsN; lesson++) {
    // остаток дневной нормы новых на начало урока - ровно то, что Review.tsx кладёт в dayNewLeft
    const dayLeft = Math.max(0, dayNew - ratedNewToday.size)
    const introduced = new Set<string>()
    const lapsed = new Set<string>()
    let reintroShown = 0
    let introBonus = 0
    let freshIntros = 0
    const introLimit = () => opts.introLimit + introBonus
    let sinceIntro = NEW_GAP
    let batchIntros = 0
    let fillersUsed = 0
    const shownTimes = new Map<string, number>()
    const drilled = new Map<string, number>()
    const sessionFails = new Map<string, number>()
    const deferred = new Set<string>()
    let lastPath: string | null = null
    let lastWasIntro = false
    const introPending = new Set<string>()
    const shows: Show[] = []
    const bars: Bar[] = []
    // byFloor последнего выбора proceed: им помечается показ, попавший на экран по аварийному полу
    let lastByFloor = false
    // Review.tsx: `shown` — закрытые показы (числитель полоски), pctFloor — храповик
    let shownCount = 0
    let pctFloor = 0

    const forced = (): Set<string> => {
      const out = new Set<string>()
      for (const [slug, at] of introAt) {
        // зеркалит forcedTodaySlugs: обязательная отработка — правило про словарное
        // знакомство. У упражнения окна-знакомства нет, первый показ уже даёт оценку
        if ((kindOf.get(slug) ?? 'vocab') !== 'vocab') continue
        const later = [...(practiceAt.get(slug) ?? [])].filter(l => l > at).length
        if (later < 2) out.add(slug)
      }
      return out
    }

    const availableFillers = (exclude: StudyItem[]): StudyItem[] => {
      if (fillersUsed >= MAX_EARLY_FILLERS) return []
      const used = new Set(exclude.map(itemKey))
      return earlyFillers(deck, new Date(now), used, MAX_EARLY_FILLERS - fillersUsed)
        .filter(i => !deferred.has(i.view.path) && !drilled.has(itemKey(i)))
    }

    const ctx = (extra: StudyItem[] = []): OrderCtx => ({
      deck, introduced, lapsed, introsLeft: introLimit() - freshIntros, reintroLeft: REINTRO_PER_LESSON - reintroShown,
      shownTimes, drilled, introPending, now, lastPath, lastWasIntro, sinceIntro, batchIntros,
      hasFiller: availableFillers(extra).length > 0
    })

    const topUp = (): StudyItem[] => {
      const fs = forced()
      if (!fs.size) return []
      return deck
        .filter(v => fs.has(v.slug) && v.fsrs.state !== State.Review)
        .map(v => ({ view: v, skill: 'recall' as const, fsrs: v.fsrs }))
        .filter(i => (drilled.get(itemKey(i)) ?? 0) < DRILL_PER_SESSION)
    }

    /** Полоска прогресса ровно как в Review.tsx: та же функция, тот же храповик. */
    const barNow = (q: StudyItem[]): Bar => {
      const c = ctx(q)
      const inQueue = new Set(q.map(itemKey))
      const pending = topUp().filter(i => !deferred.has(i.view.path) && !inQueue.has(itemKey(i)))
      // весь остаток ступени bonusNew — столько экранов урок ещё вправе себе добавить
      const pendingNew = new Set(q.filter(i => i.fsrs.state === State.New && !introduced.has(itemKey(i))).map(itemKey)).size
      const bonusSlots = Math.min(MAX_INTRO_BONUS - introBonus, dayLeft - freshIntros - pendingNew)
      const bonusItems = bonusSlots > 0
        ? nextNewItems(deck, new Set(q.map(itemKey)), bonusSlots).filter(i => !deferred.has(i.view.path))
        : []
      const input: ProgressInput = {
        shown: shownCount,
        queue: q,
        pending,
        isIntro: it => screenFormat(it, c) === 'intro',
        introsLeft: c.introsLeft,
        reintroLeft: c.reintroLeft,
        introduced,
        forced: forced(),
        drilled,
        fillerAvailable: c.hasFiller,
        bonusNew: bonusItems,
        // WS5b: по умолчанию симуляция проверяет полоску от точного объёма урока, не от
        // цели захода - Infinity держит прежнее поведение; клетка на конечную цель ниже
        // (goalProgressChecks) передаёт opts.goal явно
        goal: opts.goal ?? Infinity,
        // цель дневная, поэтому и счётчик дневной: упражнения всех уроков этого прогона,
        // а не экраны текущего урока (в них считается только знаменатель полоски)
        doneToday: unitsToday
      }
      pctFloor = Math.max(pctFloor, lessonProgress(input))
      return {
        kind: 'screen', pct: pctFloor, shown: shownCount,
        est: shownCount + estimateShowsLeft(input),
        word: q.length ? `${q[0].view.slug}/${screenFormat(q[0], c)}` : '-',
        queue: q.map(i => `${i.view.slug}:${State[i.fsrs.state]}:${drilled.get(itemKey(i)) ?? 0}`).join(',') +
          ' |добор ' + pending.map(i => `${i.view.slug}:${drilled.get(itemKey(i)) ?? 0}`).join(',') +
          ` |окон ${c.introsLeft}` + (c.hasFiller ? ' +заполнитель' : '') +
          (bonusItems.length ? ` +новых ${bonusItems.length}` : '')
      }
    }

    /**
     * Лестница добора из Review.tsx::proceed, ступень в ступень (B4):
     * готовая единица пула → недоработанные сегодняшние → батч знакомств A4-bis →
     * заполнитель → лишнее новое слово → аварийный пол разрыва. [] = урок закончен.
     * Ожидания нет по построению.
     */
    function proceed(list: StudyItem[]): StudyItem[] {
      let rest = list
      let pick = pickNext(rest, ctx(rest), { batch: false })
      if (pick.idx < 0) {
        const extra = topUp().filter(i => !deferred.has(i.view.path) && !rest.some(r => itemKey(r) === itemKey(i)))
        if (extra.length) { rest = [...rest, ...extra]; pick = pickNext(rest, ctx(rest), { batch: false }) }
      }
      if (pick.idx < 0) pick = pickNext(rest, ctx(rest))          // батч знакомств A4-bis
      if (pick.idx < 0) {
        const fill = availableFillers(rest)
        if (fill.length) { rest = [...rest, ...fill]; fillersUsed += fill.length; pick = pickNext(rest, ctx(rest)) }
      }
      // новые слова, уже стоящие в очереди урока, тратят дневную норму наравне с показанными
      const pendingNew = new Set(rest.filter(i => i.fsrs.state === State.New && !introduced.has(itemKey(i))).map(itemKey)).size
      if (pick.idx < 0 && freshIntros + pendingNew < dayLeft && introBonus < MAX_INTRO_BONUS) {
        const bonus = nextNewItems(deck, new Set(rest.map(itemKey)), 1).filter(i => !deferred.has(i.view.path))
        if (bonus.length) { rest = [...rest, ...bonus]; introBonus += bonus.length; pick = pickNext(rest, ctx(rest)) }
      }
      if (pick.idx < 0) pick = pickNext(rest, ctx(rest), { floor: true })   // аварийный пол разрыва
      if (pick.idx < 0) { lastByFloor = false; return [] }
      lastByFloor = pick.byFloor
      const q = [...rest]
      if (pick.idx > 0) { const [it] = q.splice(pick.idx, 1); q.unshift(it) }
      return q
    }

    function advance(q: StudyItem[], next: StudyItem | null, insertAt?: number): StudyItem[] {
      let rest = q.slice(1)
      if (deferred.size) rest = rest.filter(i => !deferred.has(i.view.path))
      if (next && !deferred.has(next.view.path)) {
        if (insertAt !== undefined) rest.splice(Math.min(rest.length, insertAt), 0, next)
        else if (shouldRequeue(next.fsrs, new Date(now))) {
          /* null от requeuePosition означает «очередь короче, чем нужно ждать»: боевой advance
             карточку в этом случае НЕ возвращает. Мок передавал null прямо в splice, а тот
             приводит его к нулю - карточка вставала в голову остатка и показывалась раньше
             срока там, где приложение её не показывает вовсе. */
          const pos = requeuePosition(rest.length, next.fsrs, new Date(now))
          if (pos !== null) rest.splice(pos, 0, next)
        }
      }
      return proceed(rest)
    }

    let queue = buildQueue(deck, Math.min(opts.budget, dayLeft), new Date(now), forced())
    // старт урока — тот же выбор экрана, что и дальше (иначе первый экран обходил бы инвариант)
    if (queue.length) queue = proceed(queue)
    let guard = 0
    while (queue.length && guard++ < 2000) {
      const head = queue[0]
      const fmt = screenFormat(head, ctx(queue))
      // render-эффект Review: окно-знакомство не показываем, если его нельзя отработать
      if (fmt === 'intro') {
        const freshNew = head.fsrs.state === State.New && !introduced.has(itemKey(head))
        if ((freshNew && freshIntros >= introLimit()) || !hasSeparator(queue, 0, ctx(queue))) {
          // кадр отрисован, показа не было: полоска двигаться не имеет права
          bars.push({ ...barNow(queue), kind: 'skip' })
          queue = proceed(queue.slice(1))
          continue
        }
      }

      shownTimes.set(itemKey(head), now)
      lastPath = head.view.path
      lastWasIntro = fmt === 'intro'
      if (fmt === 'intro') introPending.add(itemKey(head)); else introPending.delete(itemKey(head))
      bars.push(barNow(queue))
      shows.push({
        path: head.view.path, format: fmt, skill: head.skill, graded: null, at: now, key: itemKey(head),
        reps: head.fsrs.reps, wasNew: head.fsrs.state === State.New, byFloor: lastByFloor
      })
      const show = shows[shows.length - 1]
      now += screenMs
      shownCount++

      // «Уже знаю это слово»: знакомство сразу получает Rating.Easy и идёт общим путём оценки
      const known = fmt === 'intro' && knownWords.has(head.view.slug)

      if (fmt === 'intro') {
        /* зеркалит grade() в Review.tsx: окно тратит СВОЙ бюджет (F82) при ЛЮБОЙ оценке
           знакомства, включая Easy - иначе bonusNew вводит слово сверх нормы */
        if (head.fsrs.state === State.New && !introduced.has(itemKey(head))) freshIntros++
        else reintroShown++
        lapsed.delete(itemKey(head))
        if (!introAt.has(head.view.slug)) introAt.set(head.view.slug, lesson)
        if (!known) {
          introduced.add(itemKey(head))
          sinceIntro = 0
          batchIntros++
          queue = advance(queue, head, 2)
          continue
        }
      }

      const willFail = failWords.has(head.view.word)
      const g: Grade = known ? Rating.Easy : willFail ? Rating.Again : Rating.Good
      show.graded = g
      // дневная норма: слово, получившее оценку из New, потрачено на весь день, а не на урок
      if (head.fsrs.state === State.New) ratedNewToday.add(head.view.slug)

      let rated = f.next(head.fsrs, new Date(now), g).card
      // A1 (зеркалит store.rateItem): слово, введённое сегодня, не выходит в Review внутри дня —
      // держим в Learning со сроком на следующий учебный день. Без этого мок расходился с
      // приложением: слова уезжали в Review и выпадали из обязательной отработки.
      const introToday = introAt.has(head.view.slug)
      const wasIntroState = head.fsrs.state !== State.Review
      if (rated.state === State.Review && wasIntroState && introToday) {
        rated = { ...rated, state: State.Learning, due: endOfStudyDay(new Date(now)) }
      }
      // зеркалит store.rateItem: упражнение не возвращается в тот же учебный день
      rated = holdExerciseToNextDay(rated, new Date(now), head.view.kind)
      head.view.fsrs = rated // зеркалит store.rateItem: обновление состояния карточки в колоде
      sinceIntro++
      batchIntros = 0
      drilled.set(itemKey(head), (drilled.get(itemKey(head)) ?? 0) + 1)
      unitsToday++ // зеркалит res.current.reviews++ в Review.tsx: считаем ОЦЕНЁННЫЙ показ
      if (introAt.has(head.view.slug)) {
        const s = practiceAt.get(head.view.slug) ?? new Set<number>()
        s.add(lesson)
        practiceAt.set(head.view.slug, s)
      }

      if (g === Rating.Again) {
        lapsed.add(itemKey(head))
        const p = head.view.path
        const fails = (sessionFails.get(p) ?? 0) + 1
        sessionFails.set(p, fails)
        if (fails >= 2) {
          deferred.add(p)
          lapsed.delete(itemKey(head))
          head.view.fsrs = { ...rated, due: new Date(now + 2 * 86400_000) } // deferItemToNextDay
        }
      } else {
        lapsed.delete(itemKey(head))
      }

      queue = advance(queue, { view: head.view, skill: head.skill, fsrs: head.view.fsrs })
    }
    if (guard >= 2000) throw new Error('сессия не сошлась за 2000 шагов — вероятно, зацикливание')
    lessons.push(shows)
    allBars.push(bars)
    now += 30 * 60000 // пауза между уроками
  }
  return { lessons, bars: allBars }
}

const runSession = (deck: CardView[], opts: DayOpts): Show[] => runDay(deck, opts).lessons[0]

// ---- проверки инварианта -------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

function fmtSeq(shows: Show[]): string {
  return shows.map(s => `${s.path.replace('deck/', '').replace('.md', '')}:${s.format}`).join(' → ')
}

/**
 * A2 и A2-bis - три разрыва, а не один.
 *
 * Строгий разрыв пары «оценка → оценка» - минута (MIN_SHOW_GAP_MS), пары
 * «знакомство → первая отработка» - двадцать секунд (INTRO_GAP_MS): показ значения не
 * извлечение из памяти, остывать нечему. Ниже строгого разрыва показ законен ТОЛЬКО как
 * аварийный пол (MIN_SHOW_GAP_FLOOR_MS / INTRO_GAP_FLOOR_MS), то есть когда урок прошёл всю
 * лестницу добора и показать вместо этой карточки было нечего - ровно это и означает
 * `byFloor` выбора pickNext.
 *
 * Раньше проверка мерила ВСЕ показы полом и не спрашивала, откуда взялся короткий разрыв:
 * урок, сокративший минуту до тридцати секунд при полной очереди, тест проходил молча, а
 * пол после знакомства не проверялся вовсе (там стоял строгий INTRO_GAP_MS, и появление
 * INTRO_GAP_FLOOR_MS сделало бы проверку красной без разбора причины).
 */
function checkA2(shows: Show[], tag: string): number {
  const last = new Map<string, number>()
  const prevFmt = new Map<string, string>()
  let byFloor = 0
  for (const s of shows) {
    const prev = last.get(s.key)
    if (prev !== undefined) {
      const gap = s.at - prev
      const afterIntro = prevFmt.get(s.key) === 'intro'
      const strict = afterIntro ? INTRO_GAP_MS : MIN_SHOW_GAP_MS
      const floor = afterIntro ? INTRO_GAP_FLOOR_MS : MIN_SHOW_GAP_FLOOR_MS
      assert(gap >= floor,
        `[${tag}] A2 нарушено: ${s.key} показан через ${gap / 1000} c (пол ${floor / 1000} c).\n  ${fmtSeq(shows)}`)
      if (gap < strict) {
        assert(s.byFloor,
          `[${tag}] A2 нарушено: ${s.key} показан через ${gap / 1000} c (строгий разрыв ${strict / 1000} c), ` +
          `а выбор не аварийный - уроку было что показать вместо него.\n  ${fmtSeq(shows)}`)
        byFloor++
      }
    }
    last.set(s.key, s.at)
    prevFmt.set(s.key, s.format)
  }
  return byFloor
}

/** A3 — нет двух подряд идущих экранов одного слова. */
function checkA3(shows: Show[], tag: string): void {
  for (let i = 1; i < shows.length; i++) {
    assert(shows[i].path !== shows[i - 1].path,
      `[${tag}] A3 нарушено на #${i}: слово ${shows[i].path} встык.\n  ${fmtSeq(shows)}`)
  }
}

/** A4-bis — знакомств подряд не больше INTRO_BATCH_MAX (батч включается, когда разбавлять нечем). */
function checkA4(shows: Show[], tag: string): void {
  let run = 0
  for (const s of shows) {
    run = s.format === 'intro' ? run + 1 : 0
    assert(run <= INTRO_BATCH_MAX,
      `[${tag}] A4-bis нарушено: ${run} знакомств подряд (> ${INTRO_BATCH_MAX}).\n  ${fmtSeq(shows)}`)
  }
}

/**
 * A6 — знакомство нового слова отрабатывается в ТОМ ЖЕ уроке. Главный регресс-тест:
 * 25.07 урок показывал знакомство и завершался, слово оставалось New с датой первого показа,
 * и следующий урок повторял его один в один. Единственное допустимое исключение — знакомство
 * оказалось ПОСЛЕДНИМ экраном урока (материал кончился сразу после него): тогда слово остаётся
 * New и не помечается (A7: first_seen только с оценкой), а следующий урок вводит его заново
 * и отрабатывает. Показывать отработку встык нельзя — это A3, тот самый баг intro→reveal→type.
 */
function checkA6(shows: Show[], tag: string): void {
  const orphans: number[] = []
  shows.forEach((s, i) => {
    // только знакомства НОВЫХ слов: именно они «сгорали». Окно «Подзабылось» у зрелого слова
    // данных не портит (у него уже есть fsrs и оценки) — это ещё один показ значения.
    if (s.format !== 'intro' || !s.wasNew) return
    if (!shows.slice(i + 1).some(x => x.path === s.path && x.graded !== null)) orphans.push(i)
  })
  for (const i of orphans) {
    assert(i === shows.length - 1,
      `[${tag}] A6 нарушено: знакомство ${shows[i].path} брошено в СЕРЕДИНЕ урока.\n  ${fmtSeq(shows)}`)
  }
  assert(orphans.length <= 1,
    `[${tag}] A6 нарушено: ${orphans.length} знакомств без отработки за урок.\n  ${fmtSeq(shows)}`)
}

/**
 * C1 — производство (type) не раньше двух реальных опознаний. Проверяется по `reps` на момент
 * показа (знакомство рейтинга не даёт, поэтому reps ≥ 2 = после двух reveal/mc) и дополнительно
 * по числу опознаний внутри урока у слова, введённого этим уроком (первый экран — знакомство
 * НОВОГО слова; окно «Подзабылось» у зрелого слова под C1 не попадает — у него reps уже большой).
 */
function checkC1(shows: Show[], tag: string): void {
  const firstShow = new Map<string, Show>()
  for (const s of shows) if (!firstShow.has(s.path)) firstShow.set(s.path, s)
  const recog = new Map<string, number>()
  for (const s of shows) {
    if (s.format === 'type') {
      assert(s.reps >= 2, `[${tag}] C1 нарушено: type у ${s.path} при reps=${s.reps}.\n  ${fmtSeq(shows)}`)
      const first = firstShow.get(s.path)!
      if (first.format === 'intro' && first.wasNew) {
        assert((recog.get(s.path) ?? 0) >= 2,
          `[${tag}] C1 нарушено: type у ${s.path} после ${recog.get(s.path) ?? 0} опознаний.\n  ${fmtSeq(shows)}`)
      }
    }
    if (s.format === 'reveal' || s.format === 'mc') recog.set(s.path, (recog.get(s.path) ?? 0) + 1)
  }
}

/** C2 — ни одно слово не оценено «Заново» больше двух раз, и после второго провала не показывается. */
function checkC2(shows: Show[], tag: string): void {
  const fails = new Map<string, number>()
  const doneAt = new Map<string, number>()
  shows.forEach((s, i) => {
    if (s.graded === Rating.Again) {
      const n = (fails.get(s.path) ?? 0) + 1
      fails.set(s.path, n)
      if (n === 2) doneAt.set(s.path, i)
    }
  })
  for (const [p, n] of fails) assert(n <= 2, `[${tag}] C2 нарушено: ${p} провалено ${n} раз (>2).\n  ${fmtSeq(shows)}`)
  shows.forEach((s, i) => {
    const cut = doneAt.get(s.path)
    if (cut !== undefined) assert(i <= cut, `[${tag}] C2 нарушено: ${s.path} показано после второго провала.\n  ${fmtSeq(shows)}`)
  })
}

function checkAll(shows: Show[], tag: string): number {
  const byFloor = checkA2(shows, tag)
  checkA3(shows, tag); checkA4(shows, tag)
  checkA6(shows, tag); checkC1(shows, tag); checkC2(shows, tag)
  return byFloor
}

/**
 * Полоска прогресса урока (репро 21.08.2026).
 *
 * Прежняя дробь считала числитель в ПОКАЗАХ, а знаменатель — в ЭЛЕМЕНТАХ очереди, и на
 * живой колоде это давало откаты на 30 и 53 пункта в момент добора, систематическое
 * завышение до +43,8 п.п. и конец урока на 75–93,8% вместо 100%. Проверяем три свойства,
 * каждое из которых ломалось:
 *   — полоска не идёт назад НИ НА ОДНОМ кадре, включая кадры добора;
 *   — кадр непоказанного знакомства не двигает числитель (призрачный шаг);
 *   — урок, доработавший свою очередь, заканчивается ровно на 100%.
 */
function checkProgress(bars: Bar[], tag: string): void {
  const pc = (x: number) => (x * 100).toFixed(1) + '%'
  for (let i = 1; i < bars.length; i++) {
    assert(bars[i].pct >= bars[i - 1].pct - 1e-9,
      `[${tag}] полоска пошла НАЗАД на кадре ${i + 1}: ${pc(bars[i - 1].pct)} → ${pc(bars[i].pct)}`)
  }
  for (let i = 0; i < bars.length; i++) {
    assert(bars[i].pct > 0 && bars[i].pct <= 1 + 1e-9,
      `[${tag}] полоска вне диапазона на кадре ${i + 1}: ${pc(bars[i].pct)}`)
  }
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].kind !== 'skip') continue
    assert(bars[i].shown === bars[i - 1].shown,
      `[${tag}] пропуск непоказанного знакомства сдвинул числитель полоски на кадре ${i}: ` +
      `${bars[i - 1].shown} → ${bars[i].shown}`)
  }
  if (!bars.length) return
  if (process.env.BARDUMP) {
    console.log('DUMP', tag)
    bars.forEach((b, i) => console.log(`  ${i + 1}${b.kind === 'skip' ? 'S' : ' '} ${b.word.padEnd(20)} shown=${b.shown} est=${b.est} pct=${(b.pct * 100).toFixed(1)}  ${b.q}`))
  }
  /* 100% — только на последнем кадре. Объявить урок законченным раньше времени полоска
     не имеет права: остаток экранов после «готово» читается как обман, а не как запас. */
  for (let i = 0; i < bars.length - 1; i++) {
    assert(bars[i].pct < 1 - 1e-9,
      `[${tag}] полоска дошла до 100% на кадре ${i + 1} из ${bars.length} — до конца урока`)
  }

}

// ---- сценарии ------------------------------------------------------------

let passed = 0
function scenario(tag: string, deck: CardView[], opts: DayOpts): void {
  const run = runDay(deck, opts)
  const shows = run.lessons[0]
  const byFloor = checkAll(shows, tag)
  checkProgress(run.bars[0], tag)
  console.log(`  ✓ ${tag}: ${shows.length} экранов, инвариант держит${byFloor ? ` (по полу 30 c: ${byFloor})` : ''}`)
  passed++
}

/**
 * Репро 25.07: колода из одних новых и пул отработок из нуля/одной карточки. Три урока подряд
 * не должны быть одинаковыми, а слова обязаны получать оценки, а не только знакомства.
 */
function progressScenario(tag: string, deck: CardView[], opts: DayOpts): void {
  const newCount = deck.filter(v => v.fsrs.state === State.New).length
  // сколько уроков обязаны быть содержательными: пока в колоде есть чем вводить.
  // Дальше пустой урок законен — это честное «на сегодня всё», а не тупик.
  const required = Math.min(3, Math.max(1, Math.ceil(newCount / Math.max(1, opts.budget))))
  const { lessons, bars } = runDay(deck, { ...opts, lessons: 3 })
  const byFloor = lessons.reduce((a, shows, i) => a + checkAll(shows, `${tag}/урок${i + 1}`), 0)
  bars.forEach((b, i) => { if (b.length) checkProgress(b, `${tag}/урок${i + 1}`) })
  const rated = new Set<string>()
  let prev = 0
  lessons.forEach((shows, i) => {
    for (const s of shows) if (s.graded !== null) rated.add(s.path)
    if (i < required) {
      assert(shows.length > 0, `[${tag}] урок ${i + 1} пуст, хотя вводить ещё есть что (новых ${newCount}).`)
      assert(shows.some(s => s.graded !== null),
        `[${tag}] урок ${i + 1} состоит из одних знакомств без оценок.\n  ${fmtSeq(shows)}`)
    }
    prev = rated.size
  })
  void prev
  // за день отработано больше слов, чем ввёл бы один урок: день двигается, а не стоит
  assert(rated.size > opts.budget,
    `[${tag}] за три урока отработано всего ${rated.size} слов при лимите ${opts.budget} за урок — день не двигается`)
  // уроки не повторяются один в один (кроме двух пустых подряд — это «на сегодня всё»)
  const sigs = lessons.map(fmtSeq)
  for (let i = 1; i < sigs.length; i++) {
    assert(sigs[i] !== sigs[i - 1] || sigs[i] === '',
      `[${tag}] урок ${i + 1} повторил предыдущий один в один:\n  ${sigs[i]}`)
  }
  console.log(`  ✓ ${tag}: 3 урока — ${lessons.map(l => l.length).join('/')} экранов, отработано ${rated.size} слов, повторов нет${byFloor ? ` (по полу 30 c: ${byFloor})` : ''}`)
  passed++
}

// детерминированный ГПСЧ для повторяемости батча
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 }
}

/**
 * C3/C4/C5 — честный выход «не помню» и однозначность заданий на ввод.
 * Проверяем чистые функции планировщика/сессии, без React (реализация UI зеркалит их:
 * giveUp() выставляет suggested = Rating.Again; submitObjective роутит пустой ввод в giveUp).
 */
function dontKnowChecks(): void {
  const item = (v: CardView, fsrs = v.fsrs): StudyItem => ({ view: { ...v, fsrs }, skill: 'recall', fsrs })

  // ---- C5: type — только при однозначном ответе (есть подсказка значения) ----
  const withMeaning = reviewCard('lucid')                            // meaning_ru задан в baseView
  const withoutMeaning: CardView = { ...withMeaning, meaning_ru: '', meaning_en: '' }
  assert(hasMeaningHint(withMeaning) && !hasMeaningHint(withoutMeaning), 'C5 setup: наличие/отсутствие значения')
  // typing = 6-й аргумент. Одиночная колода → дистракторов < 3 → при typing выбор
  // type/reveal определяется только подсказкой значения.
  const fmt = (v: CardView, fsrs?: typeof withMeaning.fsrs, typing = false) =>
    pickFormat(item(v, fsrs), [v], undefined, undefined, true, typing)
  assert(fmt(withoutMeaning, undefined, true) !== 'type',
    'C5: type выдан Review-карточке без подсказки значения')
  assert(fmt(withMeaning, undefined, true) === 'type',
    'C5: при включённом вводе Review-карточка со значением допускает type')

  /* Словарь по умолчанию НЕ пишется по буквам.
     Формат `type` был основным — 271 показ из 472 в живом журнале — и не
     проверяется на SAT нигде: там словарь всегда выбор из четырёх. Теперь он
     выключен и включается настройкой; это часть контракта, а не косметика,
     поэтому проверяется в обе стороны. */
  assert(fmt(withMeaning) !== 'type', 'словарь: при выключенном вводе type не выдаётся даже со значением')
  assert(fmt(withoutMeaning) !== 'type', 'словарь: при выключенном вводе type не выдаётся и без значения')

  // Learning reps>=2 (C1 выпускает в производство) — без значения всё равно не type (C5)
  const lnNo = { ...withoutMeaning.fsrs, state: State.Learning, reps: 2 }
  const lnYes = { ...withMeaning.fsrs, state: State.Learning, reps: 2 }
  assert(fmt(withoutMeaning, lnNo, true) !== 'type', 'C5: Learning без значения — не type')
  assert(fmt(withMeaning, lnYes, true) === 'type', 'C5: Learning reps>=2 со значением и включённым вводом — type')
  assert(fmt(withMeaning, lnYes) !== 'type', 'словарь: Learning при выключенном вводе — не type')

  // числовой ответ (math) однозначен сам по себе — остаётся type даже без meaning и без настройки
  const numCard: CardView = { ...withoutMeaning, answerNum: '15', kind: 'math' }
  assert(fmt(numCard) === 'type', 'C5: числовой ответ остаётся type без meaning и без настройки ввода')

  /* C3 (S8): выход «не помню» есть и у форматов с вариантами (mc/prep).
     Кнопка была только у reveal и type, а выбор из четырёх ученик обязан был чем-то закрыть -
     то есть ткнуть наугад, и угаданный вариант уезжал в FSRS как вспомненное слово.
     React в node нет, поэтому свойство проверяется по исходнику экрана: между стопкой
     вариантов и подсказкой клавиш стоит вызов giveUp(). */
  const источник = screenSource('Review.tsx')
  const стопка = источник.indexOf('className="mc-stack">')
  assert(стопка > 0, 'C3: в Review.tsx не найдена стопка вариантов (mc-stack)')
  const подсказка = источник.indexOf('hint-keys', стопка)
  assert(подсказка > стопка, 'C3: после стопки вариантов не найдена подсказка клавиш (hint-keys)')
  assert(источник.slice(стопка, подсказка).includes('giveUp()'),
    'C3: у формата с вариантами нет выхода «не помню» - ученику остаётся гадать, а угаданный вариант засчитывается как знание')

  /* F20: rateItem обязан получать чистое время ответа (answeredMs.current), а не только
     сырое elapsedMs до кнопки «Дальше» - иначе поле answer_ms в журнале никогда не
     заполнится, и порог «медленно» продолжит калиброваться по грязному времени. */
  const rateCall = источник.slice(источник.indexOf('async function grade('), источник.indexOf('async function grade(') + 4000)
  assert(/rateItem\([^)]*answeredMs\.current/.test(rateCall),
    'F20: вызов rateItem в grade() обязан передавать answeredMs.current седьмым аргументом')

  /* C12: кнопка «подсказка» у формата type рендерится только после первой неверной
     попытки и только пока подсказка не раскрыта - иначе она либо гадание с самого
     начала показа, либо доступна бесконечно и вырождается в кнопку «пропустить».
     React в node нет, проверка по исходнику: ищем ветку `task.format === 'type'`
     кнопочного блока и внутри неё - условие рендера ровно по двум флагам. */
  const typeBranch = источник.indexOf(`) : task.format === 'type' ? (`)
  assert(typeBranch > 0, 'C12: в Review.tsx не найдена ветка кнопок формата type')
  const typeBranchEnd = источник.indexOf('\n          ) : (', typeBranch)
  assert(typeBranchEnd > typeBranch, 'C12: не найден конец ветки кнопок формата type')
  const typeBlock = источник.slice(typeBranch, typeBranchEnd)
  assert(typeBlock.includes('attempts >= 1') && typeBlock.includes('hintUsed === false'),
    'C12: кнопка подсказки обязана рендериться по условию attempts >= 1 && hintUsed === false')
  assert(typeBlock.includes('giveUp()'), 'C12: «не помню» обязана остаться доступной рядом с подсказкой')

  /* C12 (поведение): решение «что делать с попыткой ввода» вынесено в чистую функцию
     objectiveOutcome (lib/session.ts) и проверяется таблицей, а не текстом экрана.
     До 06.09.2026 механизм в живом сценарии не работал: ранняя ветка submitObjective
     стояла на условии «мимо И подсказка не раскрыта» и потому возвращалась молча на
     КАЖДОМ неверном вводе - показ не закрывался никогда, попыток было сколько угодно,
     а верный ответ на десятой из них уезжал в FSRS как «вспомнил с нуля» (correct,
     Good), не оставив в журнале ни cued, ни следа провалов. Таблица держит все исходы
     сразу: механизм осмыслен только целиком. */
  assert(objectiveOutcome({ attempt: 1, hintUsed: false, verdict: 'wrong' }) === 'retry',
    'C12: первая неверная попытка даёт второй заход, а не закрывает показ')
  assert(objectiveOutcome({ attempt: 2, hintUsed: false, verdict: 'wrong' }) === 'wrong',
    'C12: вторая неверная попытка без подсказки закрывает показ провалом - иначе попытки бесконечны')
  assert(objectiveOutcome({ attempt: 1, hintUsed: false, verdict: 'correct' }) === 'correct',
    'C12: верная первая попытка - обычный correct')
  assert(objectiveOutcome({ attempt: 2, hintUsed: false, verdict: 'correct' }) === 'correct',
    'C12: вспомнил сам со второй попытки - correct: подсказки не было')
  assert(objectiveOutcome({ attempt: 2, hintUsed: true, verdict: 'correct' }) === 'cued',
    'C12: верный ответ после подсказки - cued, а не correct')
  assert(objectiveOutcome({ attempt: 2, hintUsed: true, verdict: 'wrong' }) === 'wrong',
    'C12: мимо со скелетом перед глазами - провал, третьей попытки нет')
  assert(suggestedGrade('type', 'cued') === Rating.Hard,
    'C12: cued оценивается Hard - слово поднято не с нуля, но и не вспомнено само')
  for (const v of ['typo', 'twin'] as TypeVerdict[]) {
    assert(objectiveOutcome({ attempt: 1, hintUsed: false, verdict: v }) === v,
      `C12: ${v} проходит насквозь - это не промах, и второго захода он не требует`)
  }

  /* C12 (структура экрана): Review.tsx обязан звать objectiveOutcome и обрабатывать retry,
     а не решать заново собственным условием - иначе таблица выше стережёт пустоту. */
  const submitStart = источник.indexOf('function submitObjective(')
  assert(submitStart > 0, 'C12: в Review.tsx не найдена submitObjective')
  const submitBlock = источник.slice(submitStart, submitStart + 3000)
  assert(/objectiveOutcome\(\{ attempt: attempts \+ 1/.test(submitBlock),
    'C12: submitObjective обязана спрашивать objectiveOutcome о номере ТЕКУЩЕЙ попытки (attempts + 1)')
  assert(submitBlock.includes(`=== 'retry'`),
    'C12: submitObjective обязана обрабатывать исход retry - только он оставляет показ открытым')
  assert(!/итог === 'wrong'[^\n]*hintUsed/.test(submitBlock),
    'C12: вернулось условие «мимо и подсказка не раскрыта» - оно не закрывает показ никогда')

  /* C12/R2: скелет слова обязан быть виден отдельным элементом, а не только placeholder.
     Placeholder гаснет от первой введённой буквы и не виден в непустом поле: после
     нажатия «Подсказка» на экране не менялось ничего, и кнопка выглядела мёртвой. */
  const скелетные = источник.split('\n').filter(l => l.includes('skeletonHint(task.answer)'))
  assert(скелетные.some(l => !l.includes('placeholder')),
    'C12: скелет слова рисуется только в placeholder - на экране его не видно')
  assert(источник.includes('type-retry'),
    'C12: первый промах обязан быть виден на экране строкой - иначе «Проверить» выглядит неработающей кнопкой')

  /* C12/R2 + F20/R7: раскрытие подсказки очищает поле (вторая попытка вводится с нуля)
     и начинает отсчёт чистого времени ответа заново - в answer_ms второй попытки нет
     ни первой попытки, ни чтения самой подсказки (см. поле answer_ms в types.ts). */
  const hintStart = источник.indexOf('function applyHint(')
  assert(hintStart > 0, 'C12: в Review.tsx не найдена applyHint')
  const hintBlock = источник.slice(hintStart, hintStart + 600)
  assert(hintBlock.includes(`setTyped('')`),
    'C12: раскрытие подсказки обязано очищать поле ввода - иначе на экране не меняется ничего')
  assert(hintBlock.includes('answerFrom.current = Date.now()'),
    'F20/C12: раскрытие подсказки обязано начинать отсчёт чистого времени ответа заново')
  assert(!источник.includes('answeredMs.current = Date.now() - shownAt.current'),
    'F20/C12: чистое время ответа считается от answerFrom (его сдвигает подсказка), а не от момента показа')
  assert(источник.includes('answeredMs.current = Date.now() - answerFrom.current'),
    'F20: чистое время ответа обязано считаться от answerFrom')

  /* F82-bis (R10): слот REINTRO_PER_LESSON списывает ТОЛЬКО окно «Подзабылось». Прежний
     else к проверке новизны списывал его на любое окно, которое не прошло проверку, - в
     том числе на повторный показ знакомства уже введённого слова, и урок терял окна
     переznakomства, ни разу их не показав. */
  const списаний = источник.split('reintroShown.current++').length - 1
  assert(списаний === 1, `F82-bis: списание бюджета «Подзабылось» должно быть ровно в одном месте, найдено ${списаний}`)
  assert(источник.includes('if (reintro) reintroShown.current++'),
    'F82-bis: бюджет «Подзабылось» обязан списываться по признаку окна «Подзабылось», а не «всё, что не новое»')
  assert(источник.includes('const reintro = isReintroScreen(task.item)'),
    'F82-bis: признак окна «Подзабылось» читается ДО снятия флага провала (lapsed.delete)')

  /* Дистракторы пересобираются: авторские confusables больше не занимают всю
     четвёрку. На живой колоде confusables ровно по три у 415 карточек из 450 —
     значит варианты были зафиксированы навсегда, а 71% из них не встречаются в
     колоде больше нигде. */
  const deck5 = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(w => ({ ...reviewCard(w), word: w, pos: 'verb' }))
  const target = { ...deck5[0], confusables: ['zzz1', 'zzz2', 'zzz3'] }
  const d = mcDistractors(target, [target, ...deck5.slice(1)])
  assert(d.length === 3, `дистракторы: ожидалось 3, получено ${d.length}`)
  assert(d.filter(w => w.startsWith('zzz')).length <= 1, 'дистракторы: авторских не больше одного')
  assert(d.some(w => !w.startsWith('zzz')), 'дистракторы: есть хотя бы одно живое слово колоды')
  assert(new Set(d.map(w => w.toLowerCase())).size === d.length, 'дистракторы: без повторов')
  assert(!d.some(w => w.toLowerCase() === target.word.toLowerCase()), 'дистракторы: само слово не попадает в варианты')

  /* C6: варианты — из уже виденных слов.
     Репро жалобы 06.08.2026 «при выборе слов я просто выбираю знакомое»: в живой
     колоде 450 карточек, оценку получили 49, и три случайных дистрактора почти
     всегда были словами, которых ученик не видел ни разу. Правильный ответ
     вычислялся по новизне, не читая предложение. */
  const seenPool = ['seen1', 'seen2', 'seen3', 'seen4'].map(w => ({ ...reviewCard(w), word: w, pos: 'verb' }))
  const unseenPool = Array.from({ length: 40 }, (_, i) => {
    const w = `fresh${i}`
    return { ...newCard(w), word: w, pos: 'verb' }
  })
  // A7: знакомство без оценки словом «виденным» не делает — reps растёт только с оценкой
  assert(isSeenWord(seenPool[1]) && !isSeenWord(unseenPool[0]), 'C6: виденное отличается от невиденного по оценке, а не по показу')
  const seenTarget = { ...seenPool[0], confusables: ['zzz1', 'zzz2', 'zzz3'] }
  for (let i = 0; i < 30; i++) {
    const dd = mcDistractors(seenTarget, [seenTarget, ...seenPool.slice(1), ...unseenPool])
    assert(dd.length === 3, `C6: ожидалось 3 дистрактора, получено ${dd.length}`)
    assert(!dd.some(w => w.startsWith('fresh')), `C6: в вариантах слово, которого ученик не видел: ${dd.join(', ')}`)
    assert(!dd.some(w => w.startsWith('zzz')), `C6: незнакомая авторская ловушка выдаёт ответ так же, как незнакомый сосед: ${dd.join(', ')}`)
  }
  // знакомая авторская ловушка, наоборот, приоритетна — её и проверяет SAT
  const authoredSeen = { ...seenPool[0], confusables: ['seen4'] }
  const withAuthored = mcDistractors(authoredSeen, [authoredSeen, ...seenPool.slice(1), ...unseenPool])
  assert(withAuthored.includes('seen4'), 'C6: знакомый авторский дистрактор обязан попасть в варианты')
  // первые недели: виденных слов меньше четырёх — упражнение всё равно собирается
  const early = mcDistractors(seenTarget, [seenTarget, seenPool[1], ...unseenPool])
  assert(early.length === 3, `C6: при пустом пуле виденных MC всё равно собирается, получено ${early.length}`)

  /* C7: ротация примеров переживает перезапуск приложения.
     Индекс жил в Map внутри модуля экрана, PWA открывается заново на каждый урок,
     карточка внутри урока показывается один раз в 140 случаях из 262 — значит
     ученик видел почти исключительно contexts[0] и заучивал одно предложение. */
  assert(nextCtxIndex(null, 0, 3) === 0, 'C7: первый в жизни показ — первый пример')
  assert(nextCtxIndex(0, 0, 3) === 1, 'C7: следующий показ в том же уроке — следующий пример')
  assert(nextCtxIndex(null, 4, 3) === 1, 'C7: приложение перезапустили — счётчиком служит число оценок, не ноль')
  assert(nextCtxIndex(null, 5, 3) === 2, 'C7: reps продолжает круг, а не начинает его заново')
  assert(nextCtxIndex(null, 3, 3) === 0 && nextCtxIndex(null, 4, 3) !== nextCtxIndex(null, 5, 3),
    'C7: соседние по числу оценок показы дают разные примеры')
  assert(nextCtxIndex(2, 0, 3) === 0, 'C7: круг замыкается на первом примере')
  assert(nextCtxIndex(0, 0, 1) === 0 && nextCtxIndex(null, 7, 1) === 0, 'C7: один пример — индекс всегда 0, без деления по модулю на мусор')
  // полный цикл: три показа подряд дают три разных примера
  const seenIdx = new Set<number>()
  let idx: number | null = null
  for (let i = 0; i < 3; i++) { idx = nextCtxIndex(idx, 0, 3); seenIdx.add(idx) }
  assert(seenIdx.size === 3, 'C7: три показа подряд обязаны дать три разных примера')

  /* C8: ротация режимов проверки в Review.
     Репро жалобы 17.08.2026: «где выбор из 4 слов я просто выбираю знакомое, а в
     предложениях вижу знакомое предложение и помню, какое слово там было». До
     ротации Review отдавал ОДИН режим — выбор слова в пропуске, — потому что
     mcReady() истинно почти всегда, а ввод был выключен тумблером. Три контекста
     на слово при десяти повторах означали, что каждое предложение возвращается
     трижды. Проверяем не «есть ли режимы в массиве», а что планировщик реально
     их выдаёт и что недоступный шаг деградирует, а не пропускается (пропуск
     сдвинул бы фазу и вернул предложение в каждый показ). */
  const cycDeck = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(w => ({ ...reviewCard(w), word: w, pos: 'verb' }))
  const atReps = (reps: number, v: CardView = cycDeck[0], typing = true) => {
    const fsrs = { ...v.fsrs, state: State.Review, reps }
    return pickTask({ view: { ...v, fsrs }, skill: 'recall', fsrs }, cycDeck, undefined, undefined, true, typing)
  }
  assert(REVIEW_CYCLE.length === 4, `C8: цикл из четырёх шагов, в коде ${REVIEW_CYCLE.length}`)
  const modes = [0, 1, 2, 3].map(r => atReps(r))
  const sig = (m: { format: string; cue: string }) => `${m.format}/${m.cue}`
  assert(modes.filter(m => m.cue === 'sentence').length === 1,
    `C8: предложение показывается ровно на одном шаге из четырёх, иначе оно заучивается: ${modes.map(sig).join(', ')}`)
  assert(modes.some(m => sig(m) === 'mc/sentence'),
    'C8: формат реального экзамена (Words in Context) обязан оставаться в цикле — его надо тренировать')
  assert(modes.some(m => m.cue === 'word'),
    'C8: обратный режим (слово → значение) обязан быть в цикле — в нём узнавание английской формы не помогает')
  assert(sig(atReps(4)) === sig(atReps(0)) && sig(atReps(7)) === sig(atReps(3)),
    'C8: цикл замыкается по числу оценок, фаза не плавает')

  /* C11 (22.08.2026): производство — половина ротации, а не четверть.
     Репро жалобы того же дня: «в основном это были задания на выбрать из четырёх,
     и там я легко выбирал нужное, но щас я не могу вспомнить ни одного слова».
     Замер журнала за 22.08: словарь — 15 показов выбором против 3 вводом. Проверяем
     не состав массива, а то, что планировщик реально чередует ввод через шаг: при
     таком чередовании карточка не может набрать интервал, ни разу не пройдя ввод,
     и отдельные ворота «не выпускать, пока не введено» не нужны. */
  assert(modes.filter(m => m.format === 'type').length === 2,
    `C11: половина шагов ротации — производство, иначе слово растит интервал на одном узнавании: ${modes.map(sig).join(', ')}`)
  assert(!modes.some(m => sig(m) === 'mc/meaning'),
    'C11: «значение → слово из четырёх» — тот же вопрос, что ввод, только с подпоркой; в цикле его нет')
  assert(atReps(ROTATE_FROM_REPS).format === 'type',
    'C11: первым же шагом ротации идёт производство — до него карточка уже дважды опознана')
  assert(sig(atReps(ROTATE_FROM_REPS)) !== sig(atReps(ROTATE_FROM_REPS + 1)),
    'C11: два ввода подряд не идут — ввод чередуется с узнаванием, а не вытесняет его')

  // деградация: недоступный шаг заменяется ближайшим возможным, а не пропускается
  const noMeaning: CardView = { ...cycDeck[0], meaning_ru: '', meaning_en: '' }
  for (const r of [1, 2, 3]) {
    assert(atReps(r, noMeaning).cue === 'sentence',
      `C8: без значения шаг ${r} обязан откатиться к предложению, а не спрашивать пустоту`)
  }
  assert(atReps(3, noMeaning).format === 'mc', 'C8: без значения ввод неоднозначен — остаётся выбор')
  assert(atReps(2, cycDeck[0], false).format === 'mc' && atReps(2, cycDeck[0], false).cue === 'meaning',
    'C8: при выключенном вводе шаг производства деградирует в выбор с той же целью, а не пропускается')

  /* Дистракторы-значения: узнавание по новизне здесь не работает в принципе, но
     работает семантическая далёкость — если варианты из разных смысловых зон,
     ответ виден без знания слова. Поэтому берутся значения слов той же части речи. */
  const md = meaningDistractors(cycDeck[0], cycDeck)
  assert(md.length === 3, `C8: ожидалось 3 дистрактора-значения, получено ${md.length}`)
  assert(!md.includes(cycDeck[0].meaning_ru), 'C8: правильное значение не попадает в собственные дистракторы')
  assert(new Set(md).size === md.length, 'C8: значения без повторов')
  assert(atReps(3, cycDeck[0]).cue === 'word', 'C8: на живой колоде обратный режим собирается')
  // колода, где значений на дистракторы не хватает: обратный режим невозможен → откат к значению
  const poorDeck: CardView[] = [cycDeck[0], ...cycDeck.slice(1).map(c => ({ ...c, meaning_ru: '' }))]
  const poorFsrs = { ...cycDeck[0].fsrs, state: State.Review, reps: 3 }
  assert(meaningDistractors(cycDeck[0], poorDeck).length < 3, 'C8 setup: в бедной колоде значений действительно не хватает')
  const poorStep = pickTask(
    { view: { ...cycDeck[0], fsrs: poorFsrs }, skill: 'recall', fsrs: poorFsrs }, poorDeck, undefined, undefined, true, true)
  assert(poorStep.cue !== 'word', 'C8: без трёх значений обратный режим не собирается — шаг откатывается, а не отдаёт куцый выбор')

  /* C9: производство не должно пропадать оттого, что колода выросла.
     Ротацию раньше открывало только состояние Review, а в learning `baseFormat`
     отдаёт mc, пока в колоде находятся три дистрактора — то есть всегда. Замер
     журнала 20.08.2026: в июле, на маленькой колоде, 274 показа вводом; в этот
     день — три, и все три у карточек в Review. Слово, застрявшее в learning,
     ученик десять раз узнавал среди четырёх вариантов и ни разу не вспоминал
     сам; ровно эти слова и оказались пиявками. */
  const inLearning = (reps: number, typing = true) => {
    const fsrs = { ...cycDeck[0].fsrs, state: State.Learning, reps }
    return pickTask({ view: { ...cycDeck[0], fsrs }, skill: 'recall', fsrs }, cycDeck, undefined, undefined, true, typing)
  }
  assert(sig(inLearning(0)) === 'mc/sentence' && sig(inLearning(1)) === 'mc/sentence',
    'C9: до двух опознаний ротации нет — производство раньше срока это гарантированный провал (C1)')
  const learnModes = [2, 3, 4, 5].map(r => inLearning(r))
  assert([2, 3, 4, 5].every(r => sig(inLearning(r)) === sig(atReps(r))),
    `C9: со второго повтора learning идёт по тому же циклу, что Review: ${learnModes.map(sig).join(', ')}`)
  assert(learnModes.some(m => m.format === 'type'),
    'C9: производство доступно и в learning — иначе застрявшее там слово ни разу не вспоминают само')
  assert(learnModes.some(m => m.format === 'type'),
    'C9: слово, застрявшее в learning, обязано хоть раз спрашиваться без вариантов — иначе оно тренирует только узнавание')
  assert(inLearning(3, false).format === 'mc',
    'C9: при выключенном вводе шаг производства деградирует, а не пропадает вместе с ротацией')

  // ---- C3: «не помню» = Again, оценка не поднимается выше ----
  const giveUpRating = Rating.Again // именно это фиксирует giveUp() в UI
  for (const f of ['reveal', 'type', 'mc', 'prep'] as const) {
    // reveal → в UI считается как 'type' (объективный сигнал ввода); для остальных формат тот же
    const g = suggestedGrade(f === 'reveal' ? 'type' : f, 'wrong')
    assert(g === Rating.Again, `C3: пустой/неверный ${f} даёт Again, а не ${g}`)
  }
  assert(giveUpRating <= Rating.Again, 'C3: «не помню» не выдаёт оценку выше Again')

  // ---- C4: пустой/пробельный ввод эквивалентен «не помню» ----
  assert(isGiveUp('') && isGiveUp('   ') && isGiveUp('\t\n'), 'C4: пустое/пробельное поле = «не помню»')
  assert(!isGiveUp('bias'), 'C4: непустой ввод — не «не помню»')
  // и пустой ввод, и кнопка «не помню» идут одним путём → одна и та же оценка
  const emptyRating = isGiveUp('') ? giveUpRating : suggestedGrade('type', 'wrong')
  assert(emptyRating === giveUpRating, 'C4: пустой ввод даёт тот же рейтинг, что кнопка «не помню»')

  /* Порог «медленно» — доля от личной медианы, а не константа.
     Стоял 25 000 мс при измеренной медиане 7 412 мс и p90 17 827 мс, то есть не
     достигался почти никогда: за всю историю Again 121, Hard 6, Good 271,
     Easy 3 — 98% оценок в двух крайних категориях. */
  assert(slowThresholdMs('vocab', 7412) === Math.round(7412 * SLOW_FACTOR),
    'порог: считается от личной медианы')
  assert(slowThresholdMs('vocab', 7412) < 25_000,
    'порог: личный ниже прежней константы — иначе «Трудно» так и не появится в данных')
  assert(slowThresholdMs('vocab', 1000) >= 12_000,
    'порог: пол держит — на быстрой медиане «медленно» не должно срабатывать на здоровых ответах')
  assert(slowThresholdMs('vocab') === 25_000, 'порог: без медианы поведение прежнее')
  assert(slowThresholdMs('math', 7412) === 90_000, 'порог: математика считается отдельно')
  assert(suggestedGrade('mc', 'correct', 20_000, 'vocab', 7412) === Rating.Hard,
    '20 c при медиане 7,4 c — это Hard')
  assert(suggestedGrade('mc', 'correct', 20_000, 'vocab') === Rating.Good,
    'та же скорость на прежней константе давала Good — репро дефекта')

  /* Порог по ВИДУ карточки. Репро дефекта, из-за которого один и тот же вопрос
     разбора попадался пятый раз: общая медиана — это медиана словарных ответов
     (447 строк журнала из 464), а карточка разбора требует прочитать условие с
     таблицей и четыре длинных варианта. Замер 21.08.2026: словарные — медиана
     8,1 с, разбор (kind error) — 21,6 с при p90 43,6 с; 53% ответов на разбор
     уходили в Hard против 12% у словарных. Hard в состоянии Learning не двигает
     ступень, и карточка возвращалась в каждый следующий урок. */
  assert(suggestedGrade('mc', 'correct', 21_600, 'vocab', 8360) === Rating.Hard,
    'репро: 21,6 с по словарной мерке — заминка, и разбор судился именно ею')
  assert(suggestedGrade('mc', 'correct', 21_600, 'error', 8360) === Rating.Good,
    'тот же ответ на карточке разбора — обычный: у неё свой пол')
  assert(suggestedGrade('mc', 'correct', 21_600, 'error', 21_649) === Rating.Good,
    'и на своей набранной медиане — тоже обычный, карточка выпускается из Learning')
  assert(slowThresholdMs('error', 8360) >= 45_000,
    'порог: у разбора свой пол — иначе холодный старт наказывает длинное условие')
  assert(slowThresholdMs('error', 21_649) === Math.round(21_649 * SLOW_FACTOR),
    'порог: набралась своя медиана — считаем от неё, а не от пола')
  assert(suggestedGrade('mc', 'correct', 60_000, 'error', 21_649) === Rating.Hard,
    'минута на карточку разбора — всё-таки заминка, Hard не должен исчезнуть совсем')
  assert(slowThresholdMs('math', 7412) === 90_000, 'порог математики от правки не сдвинулся')

  /* Своя медиана берётся, только когда её есть на чём считать. */
  const speedFix = {
    medianMs: 8360,
    byKind: { vocab: { medianMs: 8147, n: 447 }, error: { medianMs: 21_649, n: 15 }, math: { medianMs: 23_898, n: 2 } }
  }
  assert(medianForKind(speedFix, 'error') === 21_649, 'медиана вида берётся, когда набралось наблюдений')
  assert(medianForKind(speedFix, 'math') === 8360, 'на двух наблюдениях медиана вида - шум, берём общую')
  assert(medianForKind(speedFix, 'grammar') === 8360, 'вида в журнале нет - общая медиана')

  /* F20 (06.09.2026), сквозной прогон journal -> speedStats -> medianForKind -> slowThresholdMs
     -> suggestedGrade: часть строк несёт чистое answer_ms, часть - только старое грязное
     elapsed_ms (с чтением вердикта/разбора внутри). Порог обязан считаться по чистому
     времени там, где оно есть, а не по завышенному elapsed_ms. */
  const чистое = 6_000      // настоящее время ответа у строк с answer_ms
  const грязное = 20_000    // то же самое действие, но с чтением разбора/вердикта внутри elapsed_ms
  const mixedJournal: JournalLine[] = [
    // 11 старых строк без answer_ms - только грязное elapsed_ms (было единственным полем до F20)
    ...Array.from({ length: 11 }, (_, i) => ({
      id: `old-${i}`, type: 'review' as const, ts: '2026-08-01T10:00:00+03:00', day: '2026-08-01',
      slug: `слово-${i}`, format: 'type', kind: 'vocab', elapsed_ms: грязное
    })),
    // 13 новых строк с чистым answer_ms - тем же грязным elapsed_ms рядом, для контраста
    ...Array.from({ length: 13 }, (_, i) => ({
      id: `new-${i}`, type: 'review' as const, ts: '2026-09-06T10:00:00+03:00', day: '2026-09-06',
      slug: `слово-нов-${i}`, format: 'type', kind: 'vocab', answer_ms: чистое, elapsed_ms: грязное
    }))
  ]
  const spMixed = speedStats(mixedJournal)
  assert(Math.abs(spMixed.cleanShare - 13 / 24) < 0.01, `сквозной F20: доля чистых замеров ожидалась ~0.54, получено ${spMixed.cleanShare}`)
  // 24 значения: 13 чистых (6000) занимают младшие индексы 0..12, 11 грязных (20000) - индексы 13..23;
  // медианные индексы 11 и 12 оба попадают на чистый блок → медиана равна чистому значению 6000, не грязному 20000
  const médianaSlov = medianForKind(spMixed, 'vocab')
  assert(médianaSlov === чистое, `сквозной F20: медиана вида vocab обязана считаться по чистому answer_ms, ожидалось ${чистое}, получено ${médianaSlov}`)
  const порогMixed = slowThresholdMs('vocab', médianaSlov)
  assert(порогMixed === Math.round(чистое * SLOW_FACTOR), `сквозной F20: порог обязан считаться от чистой медианы (2.5×6000=15000), получено ${порогMixed}`)
  // ответ за 10000мс - дольше чистой медианы (6000), но ниже порога 2.5× (15000) - должен остаться Good
  assert(suggestedGrade('type', 'correct', 10_000, 'vocab', médianaSlov) === Rating.Good,
    'сквозной F20: ответ ниже порога, посчитанного от чистой медианы, не даёт Hard')
  // ответ за 18000мс - выше порога 2.5×6000=15000 (при завышенной грязной медиане 20000 порог был бы 50000, и Hard не сработал бы никогда)
  assert(suggestedGrade('type', 'correct', 18_000, 'vocab', médianaSlov) === Rating.Hard,
    'сквозной F20: ответ выше порога, посчитанного от чистой медианы, даёт Hard (грязная медиана эту заминку маскировала бы)')

  console.log('  ✓ dont-know (C3/C4/C5): «не помню»=Again, пустой ввод=«не помню», type только со значением')
  console.log(`  ✓ ротация Review (C8): ${modes.map(sig).join(' → ')} — предложение на одном шаге из четырёх`)
  console.log('  ✓ порог «медленно»: доля от личной медианы, пол 12 c, математика отдельно')
  console.log('  ✓ порог по виду карточки: разбор считается от своей медианы, а не от словарной')

  /* Выпуск, отложенный до завтра, не роняет карточку на низ лестницы.

     Правило point 1 («слово, введённое сегодня, не уходит в Review в тот же
     учебный день») возвращает выпущенную карточку в Learning. FSRS отдаёт
     выпущенную карточку с learning_steps = 0, и раньше этот ноль уезжал в файл:
     карточка теряла пройденную лестницу, следующий Good поднимал её на ступень
     «через 10 минут», и она возвращалась в тот же урок. Замер 21.08.2026: три
     Good подряд, карточка всё ещё в Learning и приходит каждые 10 минут пять
     часов подряд — жалоба «одни и те же два примера крутятся и крутятся». */
  {
    const f = makeScheduler(RETENTION)
    const день = new Date('2026-08-20T21:00:00+04:00')
    const позже = new Date('2026-08-20T21:30:00+04:00')

    // Первый Good: New → Learning, ступень поднялась, срок внутри урока.
    const { card: шаг1 } = f.next(createEmptyCard(день), день, Rating.Good)
    const held1 = holdOnIntroDay(createEmptyCard(день), шаг1, день, '2026-08-20')
    assert(held1.state === State.Learning && held1.learning_steps === 1,
      'первый верный ответ поднимает ступень и оставляет карточку в обучении')

    // Второй Good: FSRS выпускает карточку, правило откладывает выпуск до завтра.
    const { card: сырой } = f.next(held1, позже, Rating.Good)
    assert(сырой.state === State.Review, 'FSRS на второй ступени карточку выпускает')
    const held2 = holdOnIntroDay(held1, сырой, позже, '2026-08-20')
    assert(held2.state === State.Learning, 'в день знакомства выпуск откладывается')
    assert(held2.learning_steps === LAST_LEARNING_STEP,
      'репро: отложенная карточка стоит на последней ступени, а не обнуляется вместе с состоянием')
    assert(held2.due.getTime() === endOfStudyDay(позже).getTime(),
      'отложенная карточка ждёт конца учебного дня, а не десяти минут')
    assert(held2.due.getTime() - позже.getTime() > 30 * 60_000,
      'срок отложенной карточки выходит за LEARN_AHEAD_MS — в этот урок она не вернётся')

    // Добор вытащил её ещё раз в тот же день: она снова откладывается, а не падает на низ.
    const ещёПозже = new Date('2026-08-21T00:04:00+04:00')
    const { card: сырой3 } = f.next(held2, ещёПозже, Rating.Good)
    const held3 = holdOnIntroDay(held2, сырой3, ещёПозже, '2026-08-20')
    assert(held3.due.getTime() === endOfStudyDay(ещёПозже).getTime(),
      'принудительный добор не возвращает карточку в десятиминутный цикл')

    // На следующий учебный день правило молчит — карточка выпускается по-настоящему.
    const завтра = new Date('2026-08-21T10:00:00+04:00')
    const { card: сырой4 } = f.next(held3, завтра, Rating.Good)
    const выпуск = holdOnIntroDay(held3, сырой4, завтра, '2026-08-20')
    assert(выпуск.state === State.Review, 'назавтра карточка уходит в Review, отсрочка не вечная')

    /* Второй заход того же дня. Easy выпускает карточку с ЛЮБОЙ ступени, в том
       числе с нулевой, и сохранение `prev.learning_steps` парковало её на рунг
       ниже заслуженного: назавтра верный ответ давал не выпуск, а «ещё десять
       минут» — то есть возврат в этот же урок и в следующий. */
    const деньЛёгкой = new Date('2026-08-20T21:00:00+04:00')
    const { card: лёгкая } = f.next(createEmptyCard(деньЛёгкой), деньЛёгкой, Rating.Easy)
    assert(лёгкая.state === State.Review && лёгкая.learning_steps === 0,
      'предпосылка репро: Easy выпускает карточку с нулевой ступени')
    const держимЛёгкую = holdOnIntroDay(createEmptyCard(деньЛёгкой), лёгкая, деньЛёгкой, '2026-08-20')
    assert(держимЛёгкую.state === State.Learning, 'выпуск по Easy тоже откладывается до завтра')
    const назавтра = new Date('2026-08-21T10:00:00+04:00')
    const { card: сыраяЛёгкая } = f.next(держимЛёгкую, назавтра, Rating.Good)
    const итогЛёгкой = holdOnIntroDay(держимЛёгкую, сыраяЛёгкая, назавтра, '2026-08-20')
    assert(итогЛёгкой.state === State.Review,
      'репро: один верный ответ назавтра выпускает отложенную карточку, а не двигает её на десять минут')
  }
  console.log('  ✓ отложенный выпуск: последняя ступень, ожидание до конца дня, один верный ответ назавтра')

  /* УПРАЖНЕНИЕ НЕ ПОКАЗЫВАЕТСЯ ДВАЖДЫ ЗА ОДИН УЧЕБНЫЙ ДЕНЬ — проверка на целом дне.

     Жалоба владельца 22.08.2026: «все упражнения в одном уроке по второму кругу
     пошли». Жалоба про день, значит и проверка идёт днём: три урока подряд одной
     колодой, тем же прогоном, каким проверяются остальные инварианты урока. Правило,
     проверенное только поштучно, может стоять в планировщике и не доезжать до очереди.

     Эта группа идёт ПЕРЕД поштучной намеренно: она падает первой, если правило снять,
     и потому доказана отдельно от неё (снятие правила роняло поштучную группу раньше,
     чем очередь успевала дойти до второго показа). */
  {
    /* Разборы чтения (kind error, раздел «Логика») в этом прогоне больше не участвуют: с
       09.09.2026 они изъяты из FSRS-потока целиком и живут по журналу (logic.ts), где второй
       показ того же вопроса невозможен по построению - это проверяет блок сразу за этим и
       набор `logic`. Здесь остаются упражнения, у которых FSRS-график есть: грамматика и
       математика, - именно их держит holdExerciseToNextDay, и именно на них правило могло бы
       снова разъехаться с очередью. */
    const упражнения = ['comma-rule', 'semicolon-rule'].map(s => baseView(s, 1, 'grammar'))
      .concat(['quad-setup', 'slope-basics'].map(s => baseView(s, 1, 'math')))
    const словарь = ['candid', 'lucid', 'opaque', 'terse'].map(w => reviewCard(w))
    const { lessons } = runDay([...упражнения, ...словарь], { budget: 4, introLimit: 3, lessons: 3 })

    const счёт = new Map<string, number>()
    for (const shows of lessons)
      for (const s of shows) if (s.graded !== null) счёт.set(s.path, (счёт.get(s.path) ?? 0) + 1)

    const показаны = упражнения.filter(v => (счёт.get(v.path) ?? 0) > 0)
    assert(показаны.length > 0,
      'предпосылка проверки: упражнения в уроках всё-таки показывались, иначе проверять нечего')
    const повторы = упражнения.filter(v => (счёт.get(v.path) ?? 0) > 1)
    assert(повторы.length === 0,
      `репро: за учебный день упражнение показано больше одного раза — ` +
      `${повторы.map(v => `${v.slug}×${счёт.get(v.path)}`).join(', ')}`)
  }
  console.log('  ✓ за три урока одного дня ни одно упражнение не показано дважды')
  passed++

  /* То же правило для раздела «Логика», где оно теперь держится не сроком FSRS, а журналом.
     Живые числа жалобы 22.08.2026 были именно отсюда: log-cs-cel-teksta-ne-tema - три показа
     за восемь минут, log-ii-most-trebuet-cifry - семь показов за семнадцать часов. */
  {
    const now = new Date(BASE)
    const вопросы = ['log-cs-cel-teksta', 'log-ii-most-cifry'].map(s => ({ ...baseView(s, 1, 'error'), domain: 'II' }))
    assert(вопросы.every(v => sectionOf(v) === 'logic'), 'предпосылка: это карточки раздела «Логика»')

    const свежая = buildQueue(вопросы, 2, now, undefined, new Set(), undefined, [])
    assert(свежая.length === 2 && свежая.every(i => i.skill === 'recall'),
      `пустой журнал: оба вопроса свежие и оба в очереди, получено ${свежая.length}`)

    // ответ пишется строкой журнала (logicReviewLine), FSRS-блок карточки не двигается вовсе
    const журнал: JournalLine[] = [logicReviewLine(вопросы[0], false, SCREEN_MS, SCREEN_MS, now)]
    const после = buildQueue(вопросы, 2, now, undefined, new Set(), undefined, журнал)
    assert(!после.some(i => i.view.slug === вопросы[0].slug),
      'репро: отвеченный вопрос логики в тот же учебный день не возвращается ни одним путём')
    assert(после.some(i => i.view.slug === вопросы[1].slug), 'нетронутый вопрос из очереди не пропадает')
    assert(logicStatus(вопросы[0].slug, журнал) === 'retry', 'неверный ответ переводит вопрос в возврат, а не закрывает его')

    const верно: JournalLine[] = [logicReviewLine(вопросы[1], true, SCREEN_MS, SCREEN_MS, now)]
    assert(logicStatus(вопросы[1].slug, верно) === 'solved', 'верный ответ закрывает вопрос')
    assert(pickLogic(вопросы, верно, 2, now).every(v => v.slug !== вопросы[1].slug),
      'решённый вопрос не возвращается никогда, ни сегодня, ни через месяц')
  }
  console.log('  ✓ вопрос логики не показывается дважды за день: очередь раздела считается по журналу, не по FSRS')
  passed++

  /* То же правило поштучно: срок, добор и возврат в очередь.

     По журналу за 20–21.08 видно, что путей возврата было три, и лечение
     одного из них (holdOnIntroDay) остальных не закрывало:
       — обязательный добор: `forcedTodaySlugs` считал знакомством ЛЮБОЙ первый показ
         карточки (`prev_state:0`), а у упражнения первый показ — уже полноценный
         вопрос с оценкой. Урок был обязан вернуть его ещё дважды;
       — возврат в ту же очередь по learning-шагу (`shouldRequeue`);
       — подхват следующим уроком того же вечера (`LEARN_AHEAD_MS`).
     Живые числа: `log-cs-cel-teksta-ne-tema` — три показа за восемь минут,
     `log-ii-most-trebuet-cifry` — семь показов за семнадцать часов.

     Поэтому правило стоит на СРОКЕ: он закрывает все три пути разом. */
  {
    const f = makeScheduler(RETENTION)
    const вечер = new Date('2026-08-21T23:35:00+04:00')

    assert(isExercise({ kind: 'error' }) && isExercise({ kind: 'math' }) && !isExercise({ kind: 'vocab' }),
      'упражнение — всё, что не словарная карточка')

    // предпосылка репро: FSRS ставит упражнению learning-шаг внутри того же урока
    const { card: сырое } = f.next(createEmptyCard(вечер), вечер, Rating.Good)
    assert(сырое.due.getTime() - вечер.getTime() < LEARN_AHEAD_MS,
      'репро: без правила срок упражнения лежит внутри урока')
    assert(shouldRequeue(сырое, вечер),
      'репро: с таким сроком карточка возвращается в ту же очередь')

    const держим = holdExerciseToNextDay(сырое, вечер, 'error')
    assert(держим.due.getTime() === endOfStudyDay(вечер).getTime(),
      'упражнение ждёт следующего учебного дня, а не десяти минут')
    assert(!shouldRequeue(держим, вечер), 'в тот же урок упражнение уже не вернётся')
    assert(держим.due.getTime() - вечер.getTime() > LEARN_AHEAD_MS,
      'и следующий урок этого же вечера его не подхватит')

    // состояние и ступень не трогаем: ошибка не прощается, она откладывается до завтра
    const { card: провал } = f.next(держим, вечер, Rating.Again)
    const держимПровал = holdExerciseToNextDay(провал, вечер, 'error')
    assert(держимПровал.state === провал.state && держимПровал.learning_steps === провал.learning_steps,
      'правило двигает только срок — состояние и ступень лестницы остаются как их посчитал FSRS')

    // срок только ОТОДВИГАЕТСЯ: назначенный интервал правило не приближает
    const далёкое = { ...сырое, due: new Date('2026-08-27T10:00:00+04:00') }
    assert(holdExerciseToNextDay(далёкое, вечер, 'math').due.getTime() === далёкое.due.getTime(),
      'пятидневный интервал остаётся пятидневным: правило не даёт показать сегодня, а не приближает показ')

    // словарь правилом не задет — у слова ранние повторы и есть механизм обучения
    assert(holdExerciseToNextDay(сырое, вечер, 'vocab') === сырое,
      'словарная карточка возвращается той же самой: её learning-шаги правило не трогает')

    // и второй путь — обязательный добор — упражнение больше не подхватывает
    const журнал: JournalLine[] = [
      { id: '1', type: 'review', ts: '2026-08-21T22:18:42+04:00', day: '2026-08-21',
        slug: 'log-cs-cel-teksta-ne-tema', skill: 'recall', format: 'mc', kind: 'error',
        prev_state: State.New, rating: 2 },
      { id: '2', type: 'review', ts: '2026-08-21T22:19:10+04:00', day: '2026-08-21',
        slug: 'buttress', skill: 'recall', format: 'intro', prev_state: State.New, rating: 3 },
      { id: '3', type: 'session', ts: '2026-08-21T22:30:00+04:00', day: '2026-08-21' }
    ]
    const forced = forcedTodaySlugs(журнал, '2026-08-21')
    assert(!forced.has('log-cs-cel-teksta-ne-tema'),
      'репро: упражнение больше не требует обязательной отработки в тот же день')
    assert(forced.has('buttress'),
      'словарное знакомство по-прежнему обязано быть отработано сегодня — правило A7 не тронуто')
  }
  console.log('  ✓ упражнение не возвращается в тот же учебный день: ни добором, ни learning-шагом')
  passed++

  /* C9: у задания с вариантами верный ответ ровно один.

     Живой случай 21.08.2026: «The new protocol was meant to ______ collaboration
     between the two labs», варианты facilitate и foster. foster collaboration —
     обычное английское сочетание, ответ засчитали мимо. Оба слова есть в колоде,
     и значения у них пересекаются: «облегчать, способствовать» и «способствовать,
     взращивать». Замер по живой колоде: 87 таких пар, 128 карточек из 418 (31%).

     Ловушка по написанию значений не делит и остаётся дистрактором — это она и
     проверяет знание. */
  {
    const близнец = (word: string, ru: string, confusables: string[] = []): CardView => {
      const v = baseView(word, 1, 'vocab')
      v.pos = 'verb'
      v.meaning_ru = ru
      v.confusables = confusables
      v.fsrs = { ...v.fsrs, reps: 3, state: State.Review }   // видённое слово — годится в дистракторы
      return v
    }
    const facilitate = близнец('facilitate', 'облегчать, способствовать', ['felicitate', 'foster'])
    const foster = близнец('foster', 'способствовать, взращивать')
    const felicitate = близнец('felicitate', 'поздравлять')
    const hinder = близнец('hinder', 'препятствовать, мешать')
    const converge = близнец('converge', 'сходиться в одной точке (об оценках, мнениях)')
    const diverge = близнец('diverge', 'расходиться (о путях, мнениях, линиях развития)')

    assert(sharesMeaning(facilitate, foster), 'репро: facilitate и foster делят значение «способствовать»')
    assert(!sharesMeaning(facilitate, hinder), 'разные значения двойниками не считаются')
    assert(!sharesMeaning(converge, diverge),
      'пояснение в скобках — не значение: антонимы не должны выпасть из дистракторов из-за общих «мнениях»')

    const deck = [facilitate, foster, felicitate, hinder, converge, diverge]
    const слова = mcDistractors(facilitate, deck, 3)
    assert(!слова.map(s => s.toLowerCase()).includes('foster'),
      'репро: слово-двойник не предлагается вариантом — в предложении оно тоже верно')
    assert(слова.map(s => s.toLowerCase()).includes('felicitate'),
      'ловушка по написанию остаётся: значения не делит, знание проверяет')

    const значения = meaningDistractors(facilitate, deck, 3)
    assert(!значения.includes(foster.meaning_ru),
      'в обратном режиме значение-двойник тоже не вариант')
  }
  console.log('  ✓ C9: слово-двойник не попадает в варианты ни прямым режимом, ни обратным')
  passed++
  passed++
  passed++
  passed++
  passed++
  passed++

  /* C10: во «впиши слово» синоним из колоды — не промах.

     Живой случай 21.08.2026: «The lawyer cited three precedents to ______ her
     central argument», введено bolster при загаданном buttress. Оба слова есть в
     колоде, оба значат «подкреплять», оба сочетаются с argument. Прежде это давало
     «Мимо» и Rating.Again: карточка уходила в переучивание, difficulty росла — за
     верно вспомненное значение. Считать верным тоже нельзя: тогда buttress никогда
     не выучится, его будет подменять привычный синоним. Отсюда Hard. */
  {
    const слово = (word: string, ru: string): CardView => {
      const v = baseView(word, 1, 'vocab')
      v.pos = 'verb'
      v.meaning_ru = ru
      return v
    }
    const buttress = слово('buttress', 'подкреплять, укреплять')
    const bolster = слово('bolster', 'подкреплять, поддерживать (довод, позицию, дух)')
    const felicitate = слово('felicitate', 'поздравлять')
    const колода = [buttress, bolster, felicitate]

    assert(checkTyped('bolster', 'buttress') === 'wrong',
      'предпосылка: побуквенно синоним — не тот ответ, и опечаткой он тоже не считается')
    assert(typedTwin('bolster', buttress, колода)?.word === 'bolster',
      'репро: синоним из колоды опознан по общему значению')
    assert(typedTwin('felicitate', buttress, колода) === null,
      'слово с другим значением двойником не считается — ловушка по написанию остаётся ошибкой')
    assert(typedTwin('buttrss', buttress, колода) === null,
      'опечатка не выдаётся за синоним: её нет в колоде')
    assert(typedTwin('support', buttress, колода) === null,
      'слово вне колоды не прощается: общее значение доказать нечем')
    assert(typedTwin('buttress', buttress, колода) === null, 'сам ответ не двойник самому себе')

    assert(suggestedGrade('type', 'twin', 1_000, 'vocab', 8_000) === Rating.Hard,
      'репро: синоним — Hard, а не Again; значение вспомнено, форма нет')
    assert(suggestedGrade('type', 'wrong', 1_000, 'vocab', 8_000) === Rating.Again,
      'настоящий промах остаётся Again')
    assert(suggestedGrade('type', 'twin', 90_000, 'vocab', 8_000) === Rating.Hard,
      'медленный синоним не проваливается в Again: скорость тут уже ничего не решает')
    assert(suggestedGrade('intro', 'twin') === null, 'в знакомстве оценки нет и у синонима')
  }
  console.log('  ✓ C10: синоним вместо загаданного слова — Hard и вторая попытка, а не переучивание')
  passed++
}

/**
 * Итоги урока: точность считается по ВСЕМ оценкам сессии, а не по зрелым карточкам.
 * Числа взяты из настоящего урока 25.07 12:05–12:21 (журнал): 41 оценка, 12 «Заново»,
 * зрелая карточка одна и пройдена. Экран показывал «повторов 1 · точность 100%».
 */
function summaryChecks(): void {
  const real = { reviews: 41, again: 12, passRev: 1, totalRev: 1 }
  assert(sessionAccuracy(real) === 71, `итоги: точность урока должна быть 71%, а не ${sessionAccuracy(real)}`)
  assert(matureRetention(real) === 100, 'итоги: ретеншн по зрелым остаётся отдельным числом (100%)')
  assert(sessionAccuracy({ reviews: 0, again: 0 }) === null, 'итоги: без оценок точности нет (null, а не 0%)')
  assert(matureRetention({ passRev: 0, totalRev: 0 }) === null, 'итоги: без зрелых карточек ретеншна нет')
  assert(sessionAccuracy({ reviews: 4, again: 4 }) === 0, 'итоги: все провалы - 0%, а не null')
  // L2: подсказанный ввод (cued) не идёт ни в числитель, ни в знаменатель точности урока
  assert(sessionAccuracy({ reviews: 10, again: 2, cued: 2 }) === 75,
    `L2: подсказанный ввод обязан выпадать из точности (10 оценок, 2 «Заново», 2 cued -> 75%), получено ${sessionAccuracy({ reviews: 10, again: 2, cued: 2 })}`)
  assert(sessionAccuracy({ reviews: 3, again: 0, cued: 3 }) === null,
    'L2: если все оценки урока - подсказанный ввод, знаменатель нулевой и точности нет (null)')
  assert(sessionAccuracy({ reviews: 41, again: 12 }) === 71,
    'L2: без поля cued поведение прежнее - точность считается по reviews/again как раньше')
  console.log('  ✓ итоги урока: точность по всем оценкам (репро 25.07: 41 оценка/12 «Заново» → 71%, не 100%)')
  console.log('  ✓ L2: точность урока отсекает подсказанный ввод (cued) из числителя и знаменателя')
  passed++
}

/** Заполнители (B4): в пул попадает только повтор со сроком в пределах суток, и не больше потолка. */
function fillerChecks(): void {
  const deck = [tomorrowCard('t1'), tomorrowCard('t2'), reviewCard('overdue'), newCard('fresh')]
  const f = earlyFillers(deck, new Date(BASE), new Set<string>())
  const slugs = f.map(i => i.view.slug).sort()
  assert(slugs.join(',') === 't1,t2', `B4: в заполнители попало лишнее: ${slugs.join(',')}`)
  assert(earlyFillers(deck, new Date(BASE), new Set(['deck/t1.md#recall'])).length === 1,
    'B4: заполнитель, уже стоящий в очереди, не исключён')
  assert(earlyFillers(deck, new Date(BASE), new Set<string>(), 0).length === 0, 'B4: потолок заполнителей не соблюдён')

  /* Карточка, уже спрошенная сегодня, заполнителем быть не может: иначе второй урок
     того же вечера начинается с неё — верный ответ сделал её ближайшей по сроку. */
  const сегодняшняя = tomorrowCard('t3')
  сегодняшняя.fsrs = { ...сегодняшняя.fsrs, last_review: new Date(BASE - 3600_000) }
  const вчерашняя = tomorrowCard('t4')
  вчерашняя.fsrs = { ...вчерашняя.fsrs, last_review: new Date(BASE - 26 * 3600_000) }
  const свежие = earlyFillers([сегодняшняя, вчерашняя], new Date(BASE), new Set<string>()).map(i => i.view.slug)
  assert(!свежие.includes('t3'), 'B4: карточка, спрошенная сегодня, не должна возвращаться заполнителем')
  assert(свежие.includes('t4'), 'B4: вчерашний повтор обязан остаться кандидатом в заполнители')

  console.log('  ✓ фильтр заполнителей (B4): просроченное, новое и спрошенное сегодня не берём, потолок работает')
  passed++
}

/**
 * Задача 1 (17.08.2026) — стоп ввода новых слов. Слову нужно ~21 день стабильности до
 * PRIMARY (03.10), введённое позже не успевает: с NEW_STOP_DATE бюджет новых обязан
 * стать нулевым И в основной очереди (buildQueue), И в доборе сверх урочного лимита
 * (bonusNew в Review.tsx → nextNewItems) — недобитый путь означает, что правило не
 * работает. Раньше это держалось на памяти владельца (зайти в настройки, обнулить
 * newPerDay) — запрещённый класс решения.
 */
function newStopChecks(): void {
  // граница — последняя миллисекунда до NEW_STOP_DATE и сама точка отсчёта, не календарная
  // арифметика: так тест ловит регресс и в дате константы, и в операторе сравнения (>= vs >)
  const dayBefore = new Date(NEW_STOP_DATE.getTime() - 1)
  const atStop = new Date(NEW_STOP_DATE.getTime())
  const longAfter = new Date(NEW_STOP_DATE.getTime() + 60 * 86400_000) // 20.11 — с запасом

  const deck = [reviewCard('legacy1'), reviewCard('legacy2'), newCard('alpha'), newCard('beta'), newCard('gamma')]

  const qBefore = buildQueue(deck, 3, dayBefore)
  assert(qBefore.some(i => i.fsrs.state === State.New),
    `NEW_STOP_DATE: до границы новые обязаны попадать в очередь, получили 0 из ${qBefore.length}`)

  for (const now of [atStop, longAfter]) {
    const q = buildQueue(deck, 3, now)
    const newInQueue = q.filter(i => i.fsrs.state === State.New).length
    assert(newInQueue === 0,
      `NEW_STOP_DATE: buildQueue(${now.toISOString()}) обязан дать 0 новых при бюджете 3, получили ${newInQueue}`)
    // колода не встаёт: то, что уже дозревает (legacy1/legacy2 — Review), в очередь идёт как обычно
    assert(q.some(i => i.view.slug.startsWith('legacy')),
      `NEW_STOP_DATE: после стопа повторы уже введённых слов обязаны продолжаться, очередь: ${q.map(i => i.view.slug).join(',')}`)
  }

  // доборный путь (последняя ступень лестницы Review.tsx::proceed, bonusNew → nextNewItems)
  // обязан закрываться тем же правилом — иначе «стоп» держится только наполовину
  assert(nextNewItems(deck, new Set(), 1, dayBefore).length === 1,
    'NEW_STOP_DATE: добор нового слова (nextNewItems) обязан работать до границы')
  assert(nextNewItems(deck, new Set(), 1, atStop).length === 0,
    'NEW_STOP_DATE: добор нового слова (nextNewItems) обязан быть нулевым на границе и после')

  console.log('  ✓ NEW_STOP_DATE (Задача 1): бюджет новых — 0 и в buildQueue, и в доборе (nextNewItems) с 19.09.2026, дозревание продолжается')
  passed++
}

/**
 * E3 + A8: даты планировщика считаются от ближайшей попытки, а стоп ввода новых свой у
 * каждого раздела.
 *
 * До правки стоп был один на всю колоду (19.09, по словарю), и грамматика с логикой
 * закрывались вместе со словарём: домен SEC (34 карточки, 26% вопросов RW) три месяца
 * стоял с нулём оценок и должен был закрыться навсегда за две недели до попытки. Правилу
 * пунктуации 21 день дозревания не нужен - оно знается, а не дозревает (A8).
 */
function sectionStopChecks(): void {
  const день = (d: number, m: number) => new Date(2026, m - 1, d, 10, 0, 0)

  // сами границы: раздел за разделом, включительно с даты стопа
  assert(newIntroAllowed(день(18, 9), 'rw') && !newIntroAllowed(день(19, 9), 'rw'), 'A8: словарь закрывается 19.09')
  assert(newIntroAllowed(день(20, 9), 'logic') && !newIntroAllowed(день(26, 9), 'logic'), 'A8: логика закрывается 26.09')
  assert(newIntroAllowed(день(29, 9), 'grammar') && !newIntroAllowed(день(30, 9), 'grammar'), 'A8: грамматика закрывается 30.09')
  assert(!newIntroAllowed(день(19, 9), 'math'), 'A8: математика закрывается вместе со словарём')
  assert(NEW_STOP_DATE.getTime() === NEW_STOP_BY_SECTION.rw.getTime(), 'NEW_STOP_DATE обязан остаться стопом словаря: по нему считается темп')

  const словарь = [newCard('candid'), newCard('lucid')]
  const грамматика = [baseView('semicolon', 1, 'grammar'), baseView('dangling', 1, 'grammar')]
  const логика = [{ ...baseView('log-ii-central-idea', 1, 'error'), domain: 'II' }, { ...baseView('log-cs-purpose', 1, 'error'), domain: 'CS' }]
  const математика = [baseView('quadratic', 1, 'math')]
  const колода = [...словарь, ...грамматика, ...логика, ...математика]

  const разделыНовых = (now: Date) => new Set(buildQueue(колода, 8, now).filter(i => i.fsrs.state === State.New).map(i => sectionOf(i.view)))

  const в2009 = разделыНовых(день(20, 9))
  assert(!в2009.has('rw') && !в2009.has('math'), `20.09: словарь и математика уже закрыты, получено ${[...в2009].join(',')}`)
  assert(в2009.has('grammar') && в2009.has('logic'), `20.09: грамматика и логика обязаны вводиться, получено ${[...в2009].join(',')}`)

  const в2709 = разделыНовых(день(27, 9))
  assert([...в2709].join(',') === 'grammar', `27.09: открыта только грамматика, получено ${[...в2709].join(',')}`)

  assert(разделыНовых(день(1, 10)).size === 0, '01.10: ввод закрыт всем разделам')

  // урок одного раздела: очередь строится и на срезе колоды, и правило обязано работать там же
  assert(buildQueue(грамматика, 3, день(20, 9)).some(i => i.fsrs.state === State.New), '20.09: урок грамматики обязан вводить новые')
  assert(buildQueue(словарь, 3, день(20, 9)).every(i => i.fsrs.state !== State.New), '20.09: урок слов новых не вводит')

  // добор сверх урочного лимита (bonusNew в Review.tsx) закрывается тем же правилом
  assert(nextNewItems(грамматика, new Set(), 1, день(20, 9)).length === 1, 'A8: добор грамматики работает до её стопа')
  assert(nextNewItems(словарь, new Set(), 1, день(20, 9)).length === 0, 'A8: добор слов после 19.09 нулевой')
  assert(nextNewItems(колода, new Set(), 4, день(20, 9)).every(i => sectionOf(i.view) !== 'rw'), 'A8: добор на смешанном наборе не берёт закрытый раздел')

  /* Главный экран обязан обещать ровно то, что выдаст урок: плашка «N новых» считается
     по тем же разделам, иначе она гасит открытую грамматику вместе со словарём. */
  assert(homeCounts(колода, 8, день(20, 9)).newAvail === 4, `homeCounts 20.09: доступны 4 новых (грамматика и логика), получено ${homeCounts(колода, 8, день(20, 9)).newAvail}`)
  assert(homeCounts(колода, 8, день(27, 9)).newAvail === 2, 'homeCounts 27.09: остаётся только грамматика')
  assert(homeCounts(колода, 8, день(1, 10)).newAvail === 0, 'homeCounts 01.10: новых нет')
  for (const d of [день(20, 9), день(27, 9), день(1, 10)]) {
    assert(homeCounts(колода, 8, d).newAvail === buildQueue(колода, 8, d).filter(i => i.fsrs.state === State.New).length,
      `плашка главной и очередь урока обязаны сходиться на ${d.toISOString()}`)
  }

  console.log('  ✓ A8: стоп ввода свой у раздела (слова 19.09, логика 26.09, грамматика 30.09), очередь и главная согласны')
  passed++

  // даты планировщика: ближайшая попытка, потолок сроков, фаза, окно повышенного retention
  assert(nextAttempt(день(5, 9)).getTime() === PRIMARY_DATE.getTime(), 'до 03.10 ближайшая попытка - первая')
  assert(nextAttempt(день(5, 10)).getTime() === EXAM_DATE.getTime(), 'после 03.10 ближайшая попытка - суперскорная')
  assert(dueCap(день(5, 9)).getTime() === new Date(2026, 8, 26).getTime(), '05.09: потолок сроков 26.09')
  assert(dueCap(день(29, 9)).getTime() === new Date(2026, 9, 2).getTime(), '29.09: потолок съезжает на канун 02.10')
  assert(dueCap(день(5, 10)).getTime() === new Date(2026, 9, 31).getTime(), '05.10: потолок 31.10')
  assert(phase(день(5, 9)) === 'intake', '05.09: ввод открыт - фаза intake')
  assert(phase(день(20, 9)) === 'intake', '20.09: грамматика ещё вводится - фаза intake')
  assert(phase(день(29, 9)) === 'final', '29.09: последняя неделя перед попыткой сильнее открытого ввода грамматики')
  assert(phase(день(5, 10)) === 'taper', '05.10: ввод закрыт всем, до последней недели ноября далеко')
  assert(phase(день(2, 11)) === 'final', '02.11: последняя неделя перед 07.11')
  assert(phase(день(10, 11)) === 'between', 'после последней попытки впереди дат нет')
  assert(RETENTION === 0.8, 'целевая точность продукта 0.8 (решение 09.09.2026: 0.9 крутит одни и те же слова)')
  assert(FINAL_RETENTION === 0.9 && FINAL_RETENTION > RETENTION, 'финальные две недели строже базы, но не 0.95: с базой 0.8 это сжало бы интервалы в двадцать раз')
  assert(effectiveRetention(RETENTION, день(20, 9)) === FINAL_RETENTION, '20.09: две недели до первой попытки - retention поднят до финального')
  assert(effectiveRetention(RETENTION, день(5, 10)) === RETENTION, '05.10: до ближайшей попытки месяц - retention обычный')
  assert(effectiveRetention(RETENTION, день(25, 10)) === FINAL_RETENTION, '25.10: две недели до 07.11 - retention поднят до финального')
  assert(effectiveRetention(0.95, день(25, 10)) === 0.95, 'база выше финального уровня в окне не опускается')

  console.log('  ✓ E3: ближайшая попытка, потолок сроков, фаза и окно retention считаются от даты, а не константами')
  passed++
}

/**
 * Задача 2 (17.08.2026) — слова из разборов пробников вперёд очереди. `freshItems` вводил
 * словарь строго по возрастанию уровня, поэтому провал на настоящем пробнике (source:
 * pt4/pt4-m2qNN/pt1-qNN…, см. _КОНТРАКТ.md), размеченный обычной высокой ступенью, не
 * вводился НИКОГДА: до NEW_STOP_DATE влезает порядка 264 слов, а такое стоит за сотнями
 * рутинных низкоступенчатых. Живой пример из колоды — paucity/surmise/buttress, все
 * source: pt4, level 6.
 */
function ptPriorityChecks(): void {
  const errorCard: CardView = { ...newCard('rule-dash-vs-colon'), kind: 'error' }
  const grammarCard: CardView = { ...newCard('comma-rule'), kind: 'grammar' }
  const mathCard: CardView = { ...newCard('quad-setup'), kind: 'math' }
  const routineWord = newCard('adhere', 1) // рутинный словарь, низкая ступень — введётся раньше по старому правилу
  // реальные карточки колоды: source pt4, level 6 (Учёба/Карточки/{paucity,surmise,buttress}.md)
  const ptWords = ['paucity', 'surmise', 'buttress'].map(w => ({ ...newCard(w, 6), source: 'pt4' }))

  assert(kindRank(errorCard) < kindRank(grammarCard), 'kindRank: error по-прежнему раньше grammar')
  assert(sectionOf(errorCard) === 'logic', 'предпосылка: карточка kind error - это раздел «Логика»')
  assert(kindRank(grammarCard) < kindRank(ptWords[0]), 'kindRank: pt-слово идёт ПОСЛЕ grammar')
  assert(kindRank(ptWords[0]) < kindRank(mathCard), 'kindRank: pt-слово идёт ДО math')
  assert(kindRank(ptWords[0]) < kindRank(routineWord), 'kindRank: pt-слово опережает рутинный словарь независимо от уровня')

  const deck = [errorCard, grammarCard, mathCard, routineWord, ...ptWords]
  const order = freshItems(expandItems(deck)).map(i => i.view.slug)
  /* Раздел «Логика» в FSRS-очередь не входит вовсе (09.09.2026): его карточки не разворачивает
     `expandItems`, и порядок ввода им задаёт `pickLogic` (logic.ts), а не `freshItems`.
     Проверять здесь «error раньше grammar» больше нечего - зато обязано держаться отсутствие:
     сравнение по indexOf молча проходило бы на -1, если карточка из очереди просто исчезла. */
  assert(!order.includes('rule-dash-vs-colon'),
    'freshItems: карточка логики в общий поток новых не попадает - её ведёт pickLogic')
  assert(order[0] === 'comma-rule', `freshItems: голова очереди новых - грамматика, получено ${order[0]}`)
  for (const w of ['paucity', 'surmise', 'buttress']) {
    assert(order.indexOf('comma-rule') < order.indexOf(w), `freshItems: ${w} (pt4) обязан идти после grammar`)
    assert(order.indexOf(w) < order.indexOf('quad-setup'), `freshItems: ${w} (pt4) обязан идти до math`)
    // ключевая регрессия задачи 2: 6-я ступень pt-слова обгоняет 1-ю ступень рутинного словаря
    assert(order.indexOf(w) < order.indexOf('adhere'),
      `freshItems: ${w} (pt4, level 6) обязан опередить рутинный словарь level 1 (adhere) — иначе слово не введётся никогда`)
  }
  // level — честная оценка трудности для «Пути»/статистики, приоритет её не трогает
  assert(ptWords.every(v => v.level === 6), 'pt-приоритет не должен менять level карточки')

  console.log('  ✓ pt-приоритет (Задача 2): paucity/surmise/buttress (source pt4, level 6) обгоняют рутинный словарь низкой ступени, level не тронут')
  passed++
}

/**
 * Карточка из отметки владельца (source: `отметка` или `чтение-<slug>`) — тот же класс
 * доказанного пробела, что pt-слово (23.08.2026). Живая отметка уже поднимает карточку
 * в абсолютный приоритет (markPriorityChecks), но снимается касанием — после снятия
 * карточка должна остаться наверху за счёт kindRank, а не провалиться обратно в порядок
 * по ступеням, как это чинит pt-ветка.
 */
function fromMarkPriorityChecks(): void {
  const grammarCard: CardView = { ...newCard('comma-rule'), kind: 'grammar' }
  const mathCard: CardView = { ...newCard('quad-setup'), kind: 'math' }
  const routineWord = newCard('adhere', 1) // рутинный словарь, низкая ступень
  const markedWord = { ...newCard('paucity', 6), source: 'отметка' }
  const readingWord = { ...newCard('surmise', 6), source: 'чтение-2-01-reef' }
  const routineSourceWord = { ...newCard('buttress', 6), source: 'expand-400' }

  assert(kindRank(grammarCard) < kindRank(markedWord), 'kindRank: отметка идёт ПОСЛЕ grammar')
  assert(kindRank(markedWord) < kindRank(mathCard), 'kindRank: отметка идёт ДО math')
  assert(kindRank(markedWord) < kindRank(routineWord), 'kindRank: отметка опережает рутинный словарь независимо от уровня')
  assert(kindRank(readingWord) < kindRank(routineWord), 'kindRank: чтение-<slug> опережает рутинный словарь независимо от уровня')
  assert(kindRank(routineSourceWord) === kindRank(routineWord), 'kindRank: рутинный словарь (expand-400) приоритета не получает')
  assert(kindRank(markedWord) === kindRank(readingWord), 'kindRank: отметка и чтение-<slug> дают одинаковый ранг')

  const deck = [grammarCard, mathCard, routineWord, markedWord, readingWord, routineSourceWord]
  const order = freshItems(expandItems(deck)).map(i => i.view.slug)
  assert(order.indexOf('comma-rule') < order.indexOf('paucity'), 'freshItems: paucity (отметка) идёт после grammar')
  assert(order.indexOf('paucity') < order.indexOf('quad-setup'), 'freshItems: paucity (отметка) идёт до math')
  assert(order.indexOf('paucity') < order.indexOf('adhere'),
    'freshItems: paucity (отметка, level 6) обязан опередить рутинный словарь level 1 (adhere) — иначе слово не введётся никогда после снятия отметки')
  assert(order.indexOf('surmise') < order.indexOf('adhere'),
    'freshItems: surmise (чтение-2-01-reef, level 6) обязан опередить рутинный словарь level 1 (adhere)')
  assert(order.indexOf('adhere') < order.indexOf('buttress'),
    'freshItems: buttress (expand-400, level 6) приоритета не получает и идёт позже рутинного словаря низкой ступени (adhere)')
  assert(markedWord.level === 6 && readingWord.level === 6, 'приоритет из отметки не должен менять level карточки')

  console.log('  ✓ приоритет карточки из отметки (23.08.2026): source отметка/чтение-<slug> обгоняют рутинный словарь наравне с pt, expand-400 приоритета не получает, level не тронут')
  passed++
}

/**
 * Живая отметка владельца — абсолютный приоритет ввода (22.08.2026/уточнение 23.08.2026).
 *
 * Живой пример дефекта: `sparse` отмечено 22.08.2026, карточка в колоде есть, level: 4,
 * а активная ступень — вторая (введено 16 слов из 100) — отметка не влияла ни на что,
 * потому что `freshItems` вводит словарь строго level ASC.
 *
 * Владелец уточнил постановку: отметка перебивает НЕ ТОЛЬКО ступень, но и приоритет вида
 * карточки (kindRank) — карточка идёт первой из всех New, а не только внутри словаря.
 * Проверка берёт грамматическую карточку (kindRank выше словаря: error/grammar идут ДО
 * vocab по прежнему правилу) и слово 4-й ступени с живой отметкой — отмеченное слово
 * обязано обогнать даже grammar.
 */
function markPriorityChecks(): void {
  const grammarCard: CardView = { ...newCard('comma-rule'), kind: 'grammar' } // kindRank 1 — по старому правилу шла бы первой
  const lvl1 = newCard('brief', 1)
  const lvl2 = newCard('candid', 2)
  const lvl4Marked = newCard('sparse', 4) // ступень выше активной — по level ASC не введётся месяцами

  const markOn: JournalLine = {
    id: 'mark-on', type: 'mark', ts: '2026-08-22T09:00:00+03:00', day: '2026-08-22',
    src: 'reading:2-01-reef', word: 'sparse', lemma: 'sparse', on: true
  }

  const deck = [grammarCard, lvl1, lvl2, lvl4Marked]
  const marked = liveMarkedLemmas([markOn])
  const order = freshItems(expandItems(deck), marked).map(i => i.view.slug)
  assert(order[0] === 'sparse',
    'живая отметка обязана перебить и kindRank (grammar), и ступень (4 > 1,2) — отмеченное слово идёт первым из всех New')
  // порядок ОСТАЛЬНЫХ карточек — прежний: kindRank (grammar) раньше словаря, внутри словаря — по ступеням
  assert(order.indexOf('comma-rule') < order.indexOf('brief'), 'вне отметки kindRank решает по-прежнему: grammar раньше словаря')
  assert(order.indexOf('brief') < order.indexOf('candid'), 'вне отметки порядок словаря по ступеням не изменился (1 раньше 2)')

  // from_mark: карточка отвечает отметке и без совпадения по word — если лемма отметки есть в from_mark
  const praiseCard: CardView = { ...newCard('praise', 3), from_mark: ['praised'] }
  const markPraised: JournalLine = {
    id: 'mark-praised', type: 'mark', ts: '2026-08-22T09:05:00+03:00', day: '2026-08-22',
    src: 'card:some-exercise', word: 'praised', on: true
  }
  const orderFromMark = freshItems(expandItems([grammarCard, praiseCard]), liveMarkedLemmas([markPraised])).map(i => i.view.slug)
  assert(orderFromMark[0] === 'praise', 'from_mark: карточка отвечает отметке по форме из from_mark, а не только по своему word')

  // снятая отметка (on: false) приоритета не даёт — карточка идёт как обычная новая словарная
  const markOff: JournalLine = {
    id: 'mark-off', type: 'mark', ts: '2026-08-22T10:00:00+03:00', day: '2026-08-22',
    src: 'reading:2-01-reef', word: 'sparse', lemma: 'sparse', on: false
  }
  const markedAfterOff = liveMarkedLemmas([markOn, markOff])
  assert(markedAfterOff.size === 0, 'снятие отметки убирает лемму из набора живых отметок')
  const orderAfterOff = freshItems(expandItems(deck), markedAfterOff).map(i => i.view.slug)
  assert(orderAfterOff[0] === 'comma-rule',
    'снятая отметка (on:false) приоритета не даёт: первой снова идёт grammar по kindRank, как без отметки вовсе')
  assert(
    orderAfterOff.indexOf('brief') < orderAfterOff.indexOf('candid') && orderAfterOff.indexOf('candid') < orderAfterOff.indexOf('sparse'),
    'снятая отметка: порядок словаря по ступеням (1 → 2 → 4) не нарушен'
  )

  console.log('  ✓ живая отметка (уточнение 23.08.2026): перебивает kindRank и ступень; from_mark учитывается; on:false приоритета не даёт')
  passed++
}

/**
 * Глоссы отмеченных слов текущего предложения (04.09.2026): экран Review под отмеченным
 * словом обязан показать перевод (или честное «карточки пока нет») сразу по касанию.
 * Живой пример дефекта: карточка deplete, контекст «A long siege will ______ a city's
 * grain stores, even when its walls hold.», отмечены siege и grain - и предложение
 * оставалось непонятым при каждом показе, потому что отметка красила слово и молчала.
 */
function markGlossesChecks(): void {
  const sentence = "A long siege will deplete a city's grain stores, even when its walls hold."

  // 1. слово с карточкой, найденной по word.
  const siegeCard = newCard('siege')
  const bySiege = markGlosses([siegeCard], new Set(['siege']), sentence)
  assert(bySiege.length === 1 && bySiege[0].word === 'siege' && bySiege[0].lemma === 'siege',
    `markGlosses: слово siege обязано попасть в выдачу: ${JSON.stringify(bySiege)}`)
  assert(bySiege[0].meaning === siegeCard.meaning_ru,
    `markGlosses: значение siege обязано браться из meaning_ru карточки, найденной по word: ${JSON.stringify(bySiege)}`)

  // 2. слово с карточкой, найденной ТОЛЬКО через from_mark (лемма не совпадает с word карточки).
  const granaryCard: CardView = { ...newCard('granary'), from_mark: ['grain'] }
  const byFromMark = markGlosses([granaryCard], new Set(['grain']), sentence)
  assert(byFromMark.length === 1 && byFromMark[0].word === 'grain' && byFromMark[0].lemma === 'grain',
    `markGlosses: слово grain обязано попасть в выдачу через from_mark: ${JSON.stringify(byFromMark)}`)
  assert(byFromMark[0].meaning === granaryCard.meaning_ru,
    `markGlosses: значение grain обязано браться с карточки granary, найденной по from_mark: ${JSON.stringify(byFromMark)}`)

  // 3. слово без карточки в колоде - значение null, а не отсутствие строки.
  const noCard = markGlosses([siegeCard], new Set(['walls']), sentence)
  assert(noCard.length === 1 && noCard[0].word === 'walls' && noCard[0].meaning === null,
    `markGlosses: слово без карточки обязано попасть в выдачу с meaning: null: ${JSON.stringify(noCard)}`)

  // 4. отмечено, но в ЭТОМ предложении не встречается - в выдачу не попадает.
  const notInSentence = markGlosses([siegeCard], new Set(['siege', 'palace']), sentence)
  assert(notInSentence.length === 1 && notInSentence.every(g => g.lemma !== 'palace'),
    `markGlosses: лемма, которой нет в предложении, не должна появляться в выдаче: ${JSON.stringify(notInSentence)}`)

  // 5-6. порядок по появлению в предложении и повтор леммы - одна строка.
  const orderSentence = 'Grain filled the silo, and later more grain arrived, while coin traders watched.'
  const ordered = markGlosses([], new Set(['coin', 'grain', 'palace']), orderSentence)
  assert(ordered.length === 2, `markGlosses: повтор леммы grain обязан дать одну строку, а не две: ${JSON.stringify(ordered)}`)
  assert(ordered[0].lemma === 'grain' && ordered[1].lemma === 'coin',
    `markGlosses: порядок выдачи обязан идти по появлению в предложении (grain раньше coin): ${JSON.stringify(ordered)}`)
  assert(ordered[0].word === 'Grain',
    `markGlosses: word обязан быть формой из текста (как написано), а не леммой: ${JSON.stringify(ordered)}`)

  console.log('  ✓ markGlosses (04.09.2026): карточка по word/from_mark, слово без карточки (null), лемма вне предложения не попадает, порядок и повтор')
  passed++
}

/**
 * Задача 3 (17.08.2026) - починка флага пиявки. Старое условие в store.rateItem
 * (`next.lapses >= leech_lapses + 6`) требовало lapses ≥ 6, а lapses растёт только при
 * провале карточки из состояния Review — по всей колоде максимум был 2. Реальный путь к
 * пиявке — многократный провал ИЗ Learning/Relearning (reps растёт на каждой оценке,
 * lapses не растёт вовсе): 8 подряд «Заново» дают reps=8, lapses=0, stability≈0 —
 * ровно то, что находит отчёт (isLeech из metrics.ts), и ровно то, чего старая формула
 * не видела никогда. rateItem недоступен из этого файла (пишет в IndexedDB, которого в
 * node нет — та же причина, по которой весь файл гоняет функции планировщика напрямую,
 * а store.rateItem зеркалит локально, см. точку A1 в runDay), поэтому проверяем
 * предикат, которым rateItem теперь помечает карточку (`isLeech(next) && !fm.leech`),
 * на настоящем прогоне FSRS — том же объекте `next`, который получает rateItem.
 */
function leechFlagChecks(): void {
  const f = makeScheduler(RETENTION)
  let card = createEmptyCard(new Date(BASE))
  let now = BASE
  let flaggedByNewRule = false
  let wouldFlagByOldRule = false
  const leechLapsesBase = 0 // старое поле leech_lapses: во всей колоде ни разу не проставлено (leech всегда пуст)

  for (let i = 0; i < LEECH_REPS && !flaggedByNewRule; i++) {
    card = f.next(card, new Date(now), Rating.Again).card
    now += 60_000
    if (card.lapses >= leechLapsesBase + 6) wouldFlagByOldRule = true // условие до починки
    if (isLeech(card)) flaggedByNewRule = true                        // condition в store.rateItem теперь
  }

  assert(card.reps >= LEECH_REPS, `сетап: reps обязан дорасти минимум до LEECH_REPS(${LEECH_REPS}), получили ${card.reps}`)
  assert(card.stability < LEECH_STABILITY_DAYS,
    `сетап: stability обязан остаться ниже LEECH_STABILITY_DAYS(${LEECH_STABILITY_DAYS}), получили ${card.stability}`)
  assert(card.lapses < 6, `сетап: lapses обязан остаться ниже 6 (реалистичный случай — провалы из Learning), получили ${card.lapses}`)
  assert(flaggedByNewRule, 'Пиявка: isLeech обязан сработать на карточке, которую находит отчёт (8 провалов, stability не подросла)')
  assert(!wouldFlagByOldRule, 'регресс: старая формула (lapses >= leech_lapses+6) на этом же сценарии не сработала бы никогда')

  console.log('  ✓ флаг пиявки (Задача 3): isLeech ставит флаг там, где отчёт видит пиявку; старая формула на том же прогоне молчит')
  passed++
}

/**
 * Верхняя отсечка «медленного» ответа (21.08.2026).
 *
 * У порога `slowThresholdMs` не было потолка: ответ через две минуты (отвлёкся,
 * отложил телефон, вернулся) приходил в FSRS как Hard — «трудно, но вспомнил».
 * Потолок в проекте уже есть — `cardTimeCap` (60 c обычная карточка, 180 c
 * математика), и означает он ровно это: выше него замера нет. Журнал режет по
 * нему минуты и само поле `elapsed_ms`, а путь оценки получал сырое время прямо
 * с экрана.
 *
 * Числа сетапа — из живого журнала на 21.08.2026: медиана словарного ответа
 * 8 204 мс (490 оценок), 28 строк из 523 длиннее минуты, самая длинная — 1 526 090 мс
 * (25 минут). Именно эти 28 строк раньше становились «трудно».
 */
function afkCapChecks(): void {
  const МЕДИАНА_VOCAB = 8_204
  const порог = slowThresholdMs('vocab', МЕДИАНА_VOCAB)
  assert(порог === Math.round(МЕДИАНА_VOCAB * SLOW_FACTOR), `сетап: порог «медленно» = 2,5 медианы, получили ${порог}`)
  assert(порог < CARD_TIME_CAP_MS, 'сетап: окно честного «медленно» лежит ВНУТРИ замера, иначе проверять нечего')

  // внутри замера ничего не изменилось: медленный, но настоящий ответ остаётся Hard
  assert(suggestedGrade('mc', 'correct', порог + 1, 'vocab', МЕДИАНА_VOCAB) === Rating.Hard,
    'ответ чуть медленнее порога — по-прежнему Hard')
  assert(suggestedGrade('mc', 'correct', CARD_TIME_CAP_MS, 'vocab', МЕДИАНА_VOCAB) === Rating.Hard,
    'ровно потолок — ещё замер (граница включительно, как Math.min в journalElapsedMs)')

  // регресс задачи: выше потолка латентность не имеет права понижать оценку
  for (const ms of [CARD_TIME_CAP_MS + 1, 120_000, 1_526_090]) {
    assert(suggestedGrade('mc', 'correct', ms, 'vocab', МЕДИАНА_VOCAB) === Rating.Good,
      `${ms} мс — не медленный ответ, а отсутствие замера; Hard тут сообщал бы о трудности, которой не измеряли`)
  }

  // у математики потолок свой — 180 c, и правка его не сдвинула
  assert(suggestedGrade('type', 'correct', 150_000, 'math', МЕДИАНА_VOCAB) === Rating.Hard,
    'математика: 150 c — ещё замер (потолок 180 c), и это честное «медленно»')
  assert(suggestedGrade('type', 'correct', 180_001, 'math', МЕДИАНА_VOCAB) === Rating.Good,
    'математика: выше 180 c замера нет')

  // исход важнее секундомера в обе стороны
  assert(suggestedGrade('mc', 'wrong', 600_000, 'vocab', МЕДИАНА_VOCAB) === Rating.Again,
    'провал остаётся провалом, сколько бы времени ни прошло')
  assert(suggestedGrade('type', 'twin', 600_000, 'vocab', МЕДИАНА_VOCAB) === Rating.Hard,
    'синоним (C10) оценивается по смыслу, а не по времени')

  console.log('  ✓ верхняя отсечка латентности: ответ дольше cardTimeCap — не «трудно», а отсутствие замера')
  passed++
}

/** Карточка в Learning с заданным сроком — для проверки границ «сегодня/завтра». */
function learningCard(word: string, dueAt: number): CardView {
  const v = newCard(word)
  v.fsrs = { ...v.fsrs, state: State.Learning, reps: 1, due: new Date(dueAt), last_review: new Date(BASE - 7200_000) }
  return v
}

/**
 * «Завтра» на главном экране — это завтрашний учебный день, а не всё подряд.
 *
 * Нижняя граница стояла только у повторов (`due >= конец учебного дня`), а
 * learning-половина счёта считалась от `now + LEARN_AHEAD_MS` — момента внутри
 * СЕГОДНЯШНЕГО дня. Слово, которое предстоит доучить сегодня вечером, попадало в
 * плашку «завтра».
 */
function tomorrowCountChecks(): void {
  const now = new Date(BASE)                       // 24.07.2026, 10:00
  const eod = endOfStudyDay(now).getTime()         // 25.07.2026, 04:00 — граница учебного дня
  const колода = [
    learningCard('вечером', BASE + 12 * 3600_000),   // сегодня 22:00 — это СЕГОДНЯШНЯЯ работа
    learningCard('завтра-днём', eod + 6 * 3600_000), // 25.07, 10:00 — завтрашняя
    tomorrowCard('повтор-завтра'),                   // due BASE+20 ч = 25.07, 06:00
    reviewCard('просрочен', 1, -3 * 86400_000)       // просрочка позавчерашняя
  ]

  const c = homeCounts(колода, 0, now)
  assert(c.revTomorrow === 2,
    `завтра — только «завтра-днём» и «повтор-завтра», получили ${c.revTomorrow}: вечерняя сегодняшняя карточка снова приписана к завтрашнему дню`)
  assert(c.revDue === 1, `сегодняшний долг — один просроченный повтор, получили ${c.revDue}`)
  assert(c.learnDue === 0, 'вечерняя карточка ещё не созрела: до неё больше LEARN_AHEAD_MS')

  // вторая половина диагноза не воспроизводится, и это фиксируется тестом:
  // просрочка в «завтра» не попадала и раньше — нижняя граница у повторов была.
  const однаПросрочка = homeCounts([reviewCard('старый', 1, -10 * 86400_000)], 0, now)
  assert(однаПросрочка.revTomorrow === 0 && однаПросрочка.revDue === 1,
    'просроченный повтор считается сегодняшним долгом и никогда — завтрашним планом')

  console.log('  ✓ «завтра» на главном: окно [конец учебного дня; +24 ч) для повторов и learning одинаково')
  passed++
}

/** Повтор, уже сделанный сегодня: срок уехал вперёд, last_review — этот учебный день. */
function doneTodayCard(word: string): CardView {
  const v = reviewCard(word, 1, 3 * 86400_000)
  v.fsrs = { ...v.fsrs, last_review: new Date(BASE - 3600_000) }
  return v
}

/**
 * Дневной потолок повторов.
 *
 * Ограничение стояло на одном уроке: ученик, начавший второй урок, получал ещё
 * до 60 повторов, третий — ещё, и защиты от лавины просрочки на уровне суток не
 * было. Потолок дня — 3 урочных (180), см. MAX_REVIEW_PER_DAY.
 */
function dailyReviewCapChecks(): void {
  const now = new Date(BASE)
  const ОСТАТОК = 20
  const ДОЛГ = 40
  const колода: CardView[] = []
  for (let i = 0; i < ДОЛГ; i++) колода.push(reviewCard(`долг${i}`, 1, -(i + 1) * 3600_000))
  // столько повторов раздел уже сделал сегодня (в прошлых уроках этого же дня)
  for (let i = 0; i < MAX_REVIEW_PER_DAY - ОСТАТОК; i++) колода.push(doneTodayCard(`сделано${i}`))

  const повторов = buildQueue(колода, 0, now).filter(i => i.fsrs.state === State.Review).length
  assert(повторов === ОСТАТОК,
    `дневной потолок: сегодня осталось ${ОСТАТОК} повторов, урок выдал ${повторов} — потолок дня не действует`)

  // урочный потолок никуда не делся: он про длину одного захода
  const свежий = Array.from({ length: MAX_REVIEW_PER_LESSON + 40 }, (_, i) => reviewCard(`свежий${i}`, 1, -(i + 1) * 3600_000))
  assert(buildQueue(свежий, 0, now).length === MAX_REVIEW_PER_LESSON,
    'урочный потолок остаётся: первый заход дня берёт ровно MAX_REVIEW_PER_LESSON')

  // и главное: потолок не съедает просрочку молча — счётчик главного экрана показывает весь долг
  assert(homeCounts(колода, 0, now).revDue === ДОЛГ,
    `просрочка обязана остаться видимой: «повторить» показывает ${homeCounts(колода, 0, now).revDue} вместо ${ДОЛГ}`)

  // новый день — потолок дня чист (вчерашние оценки его не занимают)
  const завтра = new Date(BASE + 86400_000)
  const завтраПовторов = buildQueue(колода, 0, завтра).filter(i => i.fsrs.state === State.Review).length
  assert(завтраПовторов === Math.min(ДОЛГ, MAX_REVIEW_PER_LESSON),
    `со сменой учебного дня потолок обнуляется, получили ${завтраПовторов}`)

  console.log('  ✓ дневной потолок повторов: урок ограничен остатком суток, долг остаётся в счётчике')
  passed++
}

/** Как reviewCard, но привязан к произвольному `now`, а не к модульной константе BASE (K2). */
function reviewCardAt(word: string, now: Date, daysLate: number, level = 1): CardView {
  const v = baseView(word, level, 'vocab')
  const f = makeScheduler(RETENTION)
  let c = v.fsrs
  let t = now.getTime() - 12 * 86400_000
  for (let i = 0; i < 5 && c.state !== State.Review; i++) {
    c = f.next(c, new Date(t), Rating.Good).card
    t += 2 * 86400_000
  }
  v.fsrs = { ...c, due: new Date(now.getTime() - daysLate * 86400_000) }
  return v
}

/** Как doneTodayCard, но для произвольного `now` (K2). */
function doneTodayCardAt(word: string, now: Date): CardView {
  const v = reviewCardAt(word, now, -3)
  v.fsrs = { ...v.fsrs, last_review: new Date(now.getTime() - 3600_000) }
  return v
}

/**
 * WS9/K2: срез overdue при переполнении дневного потолка обязан различать слово,
 * которое ученик встретит на экзамене (вопросы практики, тексты для чтения), от слова,
 * которого в корпусе нет вовсе - иначе оба одинаково просроченных слова равноценны, а это
 * не так: освежить стоит в первую очередь то, что реально понадобится.
 */
function overdueCorpusChecks(): void {
  // Финальное окно - последняя неделя перед первой попыткой (CAP_LEAD_DAYS = 7 до PRIMARY_DATE).
  const финал = new Date(2026, 9, 0, 10, 0, 0)     // 30.09.2026 - три дня до 03.10
  const заранее = new Date(2026, 8, 1, 10, 0, 0)   // 01.09.2026 - далеко до финального окна
  assert(phase(финал) === 'final', 'предпосылка: 30.09 обязан быть финальным окном')
  assert(phase(заранее) !== 'final', 'предпосылка: 01.09 обязан быть вне финального окна')

  const hits: Record<string, number> = { 'частое': 18, 'редкое': 0 }
  const corpusHits = (slug: string) => hits[slug] ?? 0

  // ---- overdue < потолка: состав среза не меняется корпусом --------------
  {
    const колода = [reviewCardAt('a', финал, 1), reviewCardAt('b', финал, 2), reviewCardAt('c', финал, 3)]
    const setOf = (q: StudyItem[]) => q.map(i => i.view.slug).sort().join(',')
    const withCorpus = buildQueue(колода, 0, финал, undefined, new Set(), corpusHits)
    const withoutCorpus = buildQueue(колода, 0, финал)
    assert(setOf(withCorpus) === setOf(withoutCorpus),
      `overdue ниже потолка: corpusHits не должен менять состав среза, получили ${setOf(withCorpus)} vs ${setOf(withoutCorpus)}`)
    assert(withCorpus.length === 3, `все три просроченных обязаны попасть в урок, получили ${withCorpus.length}`)
  }

  // ---- overdue > потолка, финальное окно: вес - просрочка × (1 + вхождения) ----
  {
    const ОСТАТОК = 1
    const колода: CardView[] = [reviewCardAt('частое', финал, 3), reviewCardAt('редкое', финал, 4)]
    for (let i = 0; i < MAX_REVIEW_PER_DAY - ОСТАТОК; i++) колода.push(doneTodayCardAt(`сделано${i}`, финал))

    const withCorpus = buildQueue(колода, 0, финал, undefined, new Set(), corpusHits)
      .filter(i => i.fsrs.state === State.Review)
    assert(withCorpus.length === ОСТАТОК,
      `предпосылка: срез равен остатку потолка (${ОСТАТОК}), получили ${withCorpus.length}`)
    assert(withCorpus[0].view.slug === 'частое',
      `18 вхождений и просрочка 3 дня обязаны войти раньше 0 вхождений и просрочки 4 дня, получили «${withCorpus[0].view.slug}»`)

    const withoutCorpus = buildQueue(колода, 0, финал).filter(i => i.fsrs.state === State.Review)
    assert(withoutCorpus[0].view.slug === 'редкое',
      `предпосылка: без corpusHits потолок берёт по чистой просрочке («редкое» просрочено сильнее), получили «${withoutCorpus[0].view.slug}»`)
  }

  // ---- overdue > потолка, ВНЕ финального окна: порядок прежний (по due) --------
  {
    const ОСТАТОК = 1
    const колода: CardView[] = [reviewCardAt('частое', заранее, 3), reviewCardAt('редкое', заранее, 4)]
    for (let i = 0; i < MAX_REVIEW_PER_DAY - ОСТАТОК; i++) колода.push(doneTodayCardAt(`сделано${i}`, заранее))

    const withCorpus = buildQueue(колода, 0, заранее, undefined, new Set(), corpusHits)
      .filter(i => i.fsrs.state === State.Review)
    assert(withCorpus.length === ОСТАТОК,
      `предпосылка: срез равен остатку потолка (${ОСТАТОК}), получили ${withCorpus.length}`)
    assert(withCorpus[0].view.slug === 'редкое',
      `вне финального окна порядок обязан остаться прежним (по due), получили «${withCorpus[0].view.slug}»`)
  }

  // ---- H1: переполнение сравнивается с reviewCap, а не с dayLeft --------------
  {
    /* Первый урок дня финальной недели: dayLeft = MAX_REVIEW_PER_DAY (180), никто
       сегодня ещё не отвечал, значит reviewCap = MAX_REVIEW_PER_LESSON (60). 100
       просроченных больше reviewCap (60), но меньше dayLeft (180) - старое условие
       `overdue.length > dayLeft` держало overflow ложным, и срез уходил по чистому
       due без корпусного веса, хотя урочный потолок всё равно резал 40 карточек. */
    const N = 100
    const колода: CardView[] = Array.from({ length: N }, (_, i) => reviewCardAt(`просрочка${i + 1}`, финал, N - i))
    const позиция70 = колода[69] // 70-е место по due (просрочка70, daysLate = 31)
    assert(позиция70.slug === 'просрочка70', `сетап: 70-е место обязано быть просрочка70, получили ${позиция70.slug}`)
    const hitsH1: Record<string, number> = { просрочка70: 1000 }
    const corpusHitsH1 = (slug: string) => hitsH1[slug] ?? 0

    const withCorpus = buildQueue(колода, 0, финал, undefined, new Set(), corpusHitsH1)
      .filter(i => i.fsrs.state === State.Review)
    assert(withCorpus.length === MAX_REVIEW_PER_LESSON,
      `предпосылка: урочный потолок режет до ${MAX_REVIEW_PER_LESSON}, получили ${withCorpus.length}`)
    assert(withCorpus.some(i => i.view.slug === 'просрочка70'),
      'H1: 100 overdue > reviewCap (60) при dayLeft 180 обязаны считаться переполнением - карточка с корпусным весом с 70-го места по due обязана попасть в срез')

    // обратный контроль: та же нагрузка, но фаза не final - порядок остаётся по due,
    // корпусный вес не должен вытащить 70-е место наверх
    const интейк = new Date(2026, 7, 1, 10, 0, 0) // 01.08.2026 - задолго до любого стопа ввода
    assert(phase(интейк) === 'intake', 'предпосылка: 01.08 обязан быть фазой intake')
    const колодаИнтейк: CardView[] = Array.from({ length: N }, (_, i) => reviewCardAt(`просрочка${i + 1}`, интейк, N - i))
    const withCorpusIntake = buildQueue(колодаИнтейк, 0, интейк, undefined, new Set(), corpusHitsH1)
      .filter(i => i.fsrs.state === State.Review)
    const withoutCorpusIntake = buildQueue(колодаИнтейк, 0, интейк).filter(i => i.fsrs.state === State.Review)
    assert(!withCorpusIntake.some(i => i.view.slug === 'просрочка70'),
      'в фазе intake переполнение не пересортировывает срез корпусным весом - 70-е место по due в него не попадает')
    const setOfIntake = (q: StudyItem[]) => q.map(i => i.view.slug).sort().join(',')
    assert(setOfIntake(withCorpusIntake) === setOfIntake(withoutCorpusIntake),
      `в фазе intake corpusHits не должен менять состав среза, получили ${setOfIntake(withCorpusIntake)} vs ${setOfIntake(withoutCorpusIntake)}`)
    const ожидаемыеТоп60 = Array.from({ length: MAX_REVIEW_PER_LESSON }, (_, i) => `просрочка${i + 1}`).sort().join(',')
    assert(setOfIntake(withCorpusIntake) === ожидаемыеТоп60,
      `в фазе intake срез обязан остаться первыми ${MAX_REVIEW_PER_LESSON} по due (просрочка1..${MAX_REVIEW_PER_LESSON}), получили ${setOfIntake(withCorpusIntake)}`)
  }

  console.log('  ✓ K2: overdue при переполнении в финальном окне весится корпусом, вне окна и ниже потолка - прежнее поведение')
  console.log('  ✓ H1: переполнение считается против reviewCap, а не dayLeft - потолок урока (60 из 180) уже переполнение')
  passed++
}

/**
 * Провал зрелой карточки: Relearning со сроком «сейчас» (в Relearning попадают только из Review).
 * Провал случился ВЧЕРА (last_review до rollover 04:00), поэтому в «сделано сегодня» он не
 * входит и остаток дня целиком доступен ему самому.
 */
function relearnCard(word: string): CardView {
  const v = reviewCard(word, 1, -600_000)
  v.fsrs = { ...v.fsrs, state: State.Relearning, lapses: 1, due: new Date(BASE - 600_000), last_review: new Date(BASE - 8 * 3600_000) }
  return v
}

/**
 * F14: потолки повторов считаются в одной валюте с тем, что записано в «сделано».
 *
 * `reviewsLeftToday` с самого начала считал сделанным Review И Relearning, а срезался по
 * этому остатку один только бакет просрочки: весь learning-бакет (Learning + Relearning)
 * уходил в урок целиком. Провал зрелого слова попадал в знаменатель лимита, но самим лимитом
 * не ограничивался, и чем хуже шёл день, тем сильнее фактическая нагрузка превышала
 * объявленные MAX_REVIEW_PER_DAY: замер аудита на 400 просроченных карточках дал 246 оценок
 * за день при 10-30% провалов, репро на этом дереве - 260 повторов при нулевом остатке дня.
 *
 * Контракт: повтор созревшей карточки - это Review и Relearning вместе, и оба потолка (урочный
 * и дневной) распространяются на них одинаково. Знакомство сегодняшнего слова (Learning) вне
 * этого счёта: у ввода своя граница NEW_PER_DAY, и в «сделано» Learning не входит - обе
 * стороны учёта согласованы.
 */
function relearnCapChecks(): void {
  const now = new Date(BASE)
  const ОСТАТОК = 20
  const провалы = Array.from({ length: 40 }, (_, i) => relearnCard(`провал${i}`))
  const просрочка = Array.from({ length: 40 }, (_, i) => reviewCard(`долг${i}`, 1, -(i + 1) * 3600_000))
  const сделано = Array.from({ length: MAX_REVIEW_PER_DAY - ОСТАТОК }, (_, i) => doneTodayCard(`сделано${i}`))

  const q = buildQueue([...провалы, ...просрочка, ...сделано], 0, now)
  const повторов = q.filter(i => i.fsrs.state === State.Review || i.fsrs.state === State.Relearning).length
  const relearn = q.filter(i => i.fsrs.state === State.Relearning).length
  assert(повторов === ОСТАТОК,
    `дневной потолок обязан считать провалы и просрочку одной валютой: остаток дня ${ОСТАТОК}, урок выдал ${повторов}`)
  assert(relearn === ОСТАТОК,
    `остаток дня уходит провалам раньше просрочки: Relearning в уроке ${relearn} из ${повторов}`)

  // день исчерпан целиком: провалы не проходят мимо потолка, как проходили до правки
  const исчерпан = buildQueue([...провалы, ...просрочка, ...Array.from({ length: MAX_REVIEW_PER_DAY }, (_, i) => doneTodayCard(`всё${i}`))], 0, now)
  assert(исчерпан.filter(i => i.fsrs.state === State.Relearning).length === 0,
    `при нулевом остатке дня урок не имеет права выдавать провалы, выдано ${исчерпан.filter(i => i.fsrs.state === State.Relearning).length}`)

  // урочный потолок тоже общий: 60 повторов за заход, из чего бы они ни состояли
  const свежийДень = buildQueue([...провалы, ...просрочка], 0, now)
  const заход = свежийДень.filter(i => i.fsrs.state === State.Review || i.fsrs.state === State.Relearning).length
  assert(заход === MAX_REVIEW_PER_LESSON,
    `урочный потолок общий для провалов и просрочки: ожидалось ${MAX_REVIEW_PER_LESSON}, получено ${заход}`)

  /* Знакомство сегодняшнего слова потолком повторов не режется: у ввода своя граница, и
     отработка только что введённого слова обязана дойти до конца даже в исчерпанный день. */
  const сегодняшние = Array.from({ length: 5 }, (_, i) => learningCard(`сегодня${i}`, BASE - 60_000))
  const сИсчерпанным = buildQueue([...сегодняшние, ...Array.from({ length: MAX_REVIEW_PER_DAY }, (_, i) => doneTodayCard(`всё${i}`))], 0, now)
  assert(сИсчерпанным.filter(i => i.fsrs.state === State.Learning).length === 5,
    'Learning вне потолка повторов: сегодняшнее знакомство доводится до отработки при любом остатке дня')

  console.log('  ✓ F14: провалы и просрочка делят один потолок дня и урока, знакомство считается отдельно')
  passed++
}

/**
 * Пиявка изымается из уроков на время переработки.
 *
 * Флаг ставился и снимался, но состав урока не менял: карточка, про которую уже
 * доказано, что повторение её не лечит, крутилась в очереди наравне со всеми.
 * Замер живой колоды 21.08.2026: 11 помеченных карточек съели 185 показов из 637
 * за всю историю и 57 из 153 за последние две недели.
 *
 * Контур замыкается через колоду: `tools/пиявки.mjs` отбирает карточки по полю
 * `leech`, переписывает материал и СНИМАЕТ поле, а слияние берёт за базу
 * удалённый фронтматтер (yamlfm.ts::mergeCard) — снятая метка доезжает до
 * приложения. Обе стороны контура здесь и проверяются.
 */
function leechQuarantineChecks(): void {
  const now = new Date(BASE)
  const сегодня = dayKey(now)
  const пиявка = reviewCard('corroborate', 1, -3600_000)
  пиявка.fsrs = { ...пиявка.fsrs, reps: 22, stability: 1.4 }  // живой corroborate на 21.08.2026
  пиявка.leech = сегодня
  assert(isLeech(пиявка.fsrs), 'сетап: карточка обязана быть пиявкой по общему предикату (metrics.ts::isLeech)')
  const сосед = reviewCard('сосед', 1, -3600_000)
  const колода = [пиявка, сосед]

  const очередь = buildQueue(колода, 0, now).map(i => i.view.slug)
  assert(!очередь.includes('corroborate'), 'помеченная пиявка не выдаётся уроку: она ждёт переработки, а не ещё одной встречи')
  assert(очередь.includes('сосед'), 'изъятие касается только помеченной карточки')
  assert(homeCounts(колода, 0, now).revDue === 1,
    'счётчик «повторить» тоже не обещает изъятую карточку — экран и урок обязаны сходиться')
  assert(!earlyFillers(колода, now, new Set()).some(i => i.view.slug === 'corroborate'),
    'и заполнителем пиявку не подбираем — иначе изъятие обходится с чёрного хода')

  // карточка не тронута: изъятие — фильтр очереди, а не правка колоды
  assert(пиявка.fsrs.reps === 22 && пиявка.leech === сегодня && !пиявка.suspended,
    'ни история, ни расписание, ни флаг карточки не меняются')

  // после переработки (пиявки.mjs снимает поле leech) слово возвращается в урок
  const переработана: CardView = { ...пиявка, leech: '' }
  assert(buildQueue([переработана, сосед], 0, now).some(i => i.view.slug === 'corroborate'),
    'снятая метка возвращает карточку в очередь — с той же историей и тем же сроком')

  // карантин не бессрочен: инструмент берёт только словарные карточки (у error/grammar/math
  // ответ в choices, и правку контракт колоды запрещает) и может не запускаться вовсе
  const забытая: CardView = { ...пиявка, leech: addDaysKey(сегодня, -LEECH_QUARANTINE_DAYS) }
  assert(buildQueue([забытая, сосед], 0, now).some(i => i.view.slug === 'corroborate'),
    `через ${LEECH_QUARANTINE_DAYS} дней карточка возвращается сама: молча выбросить слово из подготовки нельзя`)
  const внутриНедели: CardView = { ...пиявка, leech: addDaysKey(сегодня, -(LEECH_QUARANTINE_DAYS - 1)) }
  assert(!buildQueue([внутриНедели, сосед], 0, now).some(i => i.view.slug === 'corroborate'),
    'внутри срока карантин держится')

  // мусор вместо даты карантина не открывает: бессрочное изъятие хуже пиявки
  const кривая: CardView = { ...пиявка, leech: 'true' }
  assert(buildQueue([кривая, сосед], 0, now).some(i => i.view.slug === 'corroborate'),
    'нечитаемая дата в leech не должна прятать слово навсегда')

  console.log('  ✓ пиявка изъята из уроков на время переработки и возвращается снятием метки (или по сроку карантина)')
  passed++
}

/**
 * C13 (05.09.2026): пиявка, вернувшаяся из карантина без переработки, спрашивается
 * не общей ротацией REVIEW_CYCLE, а экзаменационным путём.
 *
 * leechReturned живёт рядом с inRework: та же дата leech, то же
 * LEECH_QUARANTINE_DAYS, но по другую сторону границы. Три исхода:
 * ещё в карантине (null, ведёт inRework), первый показ после возврата
 * ('first') и все следующие до ближайшей попытки ('later'). pickTask
 * превращает их в reveal с корнем и разводкой (первый показ) и mc/sentence
 * (Words in Context) дальше, но никогда обратно в type, формат, который
 * эти же слова и провалили 31-44% раз против 88% у mc (замер 05.09).
 */
function leechReturnedChecks(): void {
  const now = new Date(BASE)
  const сегодня = dayKey(now)
  // соседи по колоде нужны только ради трёх дистракторов у mcDistractors, сами не пиявки
  const соседи = ['сосед1', 'сосед2', 'сосед3', 'сосед4'].map(w => reviewCard(w))

  // первый показ после возврата: карантин истёк, но ни одного повтора с момента возврата не было
  const первая: CardView = reviewCard('attribute', 1, -3600_000)
  первая.leech = addDaysKey(сегодня, -8)
  первая.fsrs = { ...первая.fsrs, last_review: new Date(BASE - 9 * 86400_000) }
  assert(leechReturned(первая, now) === 'first',
    `пиявка вне карантина без повторов после возврата обязана дать 'first', получили ${leechReturned(первая, now)}`)
  const итемПервая: StudyItem = { view: первая, skill: 'recall', fsrs: первая.fsrs }
  const задачаПервая = pickTask(итемПервая, [первая, ...соседи], undefined, undefined, true, false, now)
  assert(задачаПервая.format === 'reveal' && задачаПервая.cue === 'sentence',
    `первый показ вернувшейся пиявки обязан быть reveal/sentence, получили ${задачаПервая.format}/${задачаПервая.cue}`)

  // после этого показа (last_review сегодня) даёт 'later', и pickTask больше не отдаёт reveal
  const позже: CardView = { ...первая, fsrs: { ...первая.fsrs, last_review: new Date(now) } }
  assert(leechReturned(позже, now) === 'later',
    `после первого показа после возврата пиявка обязана дать 'later', получили ${leechReturned(позже, now)}`)
  const итемПозже: StudyItem = { view: позже, skill: 'recall', fsrs: позже.fsrs }
  const задачаПозже = pickTask(итемПозже, [позже, ...соседи], undefined, undefined, true, false, now)
  assert(задачаПозже.format === 'mc' && задачаПозже.cue === 'sentence',
    `дальнейшие показы вернувшейся пиявки обязаны быть mc/sentence (Words in Context), получили ${задачаПозже.format}/${задачаПозже.cue}`)
  assert(задачаПозже.format !== 'type',
    'вернувшаяся пиявка до ближайшей попытки не должна получать type, формат, который она и проваливала')

  // внутри карантина - null, существующая проверка на LEECH_QUARANTINE_DAYS остаётся зелёной
  const вКарантине: CardView = { ...первая, leech: addDaysKey(сегодня, -3) }
  assert(leechReturned(вКарантине, now) === null,
    `карточка внутри карантина не считается «вернувшейся», получили ${leechReturned(вКарантине, now)}`)
  assert(expandItems([вКарантине], now).length === 0,
    'внутри карантина карточка не даёт учебных единиц, держит inRework, LEECH_QUARANTINE_DAYS не тронут')

  console.log('  ✓ C13: первый показ вернувшейся пиявки - reveal/sentence, дальше mc/sentence, в карантине - null')
  passed++
}

/**
 * H3 (06.09.2026): ветка пиявок в pickTask обещала (в комментарии) вернуть слово
 * в обычную ротацию «после любой попытки», но проверяла это через `phase(now) !==
 * 'between'` - а `phase` считается от БУДУЩЕЙ попытки (`nextAttempt`) и держится
 * 'final'/'taper' весь промежуток между 03.10 и 07.11, то есть НИКОГДА не даёт
 * 'between' раньше 07.11. Слово, вернувшееся из карантина ЗАДОЛГО до первой
 * попытки, получало ветку пиявок и после неё - ровно то, что комментарий обещал
 * не делать.
 *
 * Верная граница - `lastAttempt`: если карантин карточки кончился ДО последней уже
 * прошедшей попытки, ученик застал слово на самой попытке и вернуться должен в
 * обычную ротацию; если карантин кончился ПОСЛЕ (или попыток ещё не было,
 * `lastAttempt` даёт `null`), ветка пиявок действует как раньше.
 */
function leechAfterAttemptChecks(): void {
  // соседи по колоде нужны только ради трёх дистракторов у mcDistractors, сами не пиявки
  const соседи = ['сосед1', 'сосед2', 'сосед3', 'сосед4'].map(w => reviewCard(w))

  const карточкаСВозвратом = (word: string, конецКарантинаKey: string, lastReview: Date | null): CardView => {
    const v = reviewCard(word, 1, -3600_000)
    v.leech = addDaysKey(конецКарантинаKey, -LEECH_QUARANTINE_DAYS)
    v.fsrs = { ...v.fsrs, reps: 2, state: State.Review, last_review: lastReview }
    return v
  }

  // ---- now = 05.10.2026, после попытки 03.10 (lastAttempt = PRIMARY_DATE) --------
  {
    const now = new Date(2026, 9, 5, 10, 0, 0)
    assert(lastAttempt(now)?.getTime() === PRIMARY_DATE.getTime(),
      'предпосылка: 05.10 обязан давать lastAttempt = PRIMARY_DATE (03.10)')

    // возврат 20.09 - карантин кончился ДО последней попытки: обычная ротация,
    // reps=2 в REVIEW_CYCLE - это {type, meaning}, и type здесь допустим
    const возвратДоПопытки = карточкаСВозвратом('attribute', '2026-09-20', new Date(2026, 8, 25))
    const итем1: StudyItem = { view: возвратДоПопытки, skill: 'recall', fsrs: возвратДоПопытки.fsrs }
    const задача1 = pickTask(итем1, [возвратДоПопытки, ...соседи], undefined, undefined, true, true, now)
    assert(задача1.format === 'type' && задача1.cue === 'meaning',
      `возврат до последней попытки обязан идти обычной ротацией (type/meaning на reps=2), получили ${задача1.format}/${задача1.cue}`)

    // возврат 04.10 - карантин кончился ПОСЛЕ последней попытки: ветка пиявок,
    // 'later' (last_review в день конца карантина) даёт mc/sentence, не type
    const возвратПослеПопытки = карточкаСВозвратом('buttress', '2026-10-04', new Date(2026, 9, 4, 15, 0, 0))
    assert(leechReturned(возвратПослеПопытки, now) === 'later',
      `сетап: карточка обязана дать 'later', получили ${leechReturned(возвратПослеПопытки, now)}`)
    const итем2: StudyItem = { view: возвратПослеПопытки, skill: 'recall', fsrs: возвратПослеПопытки.fsrs }
    const задача2 = pickTask(итем2, [возвратПослеПопытки, ...соседи], undefined, undefined, true, false, now)
    assert(задача2.format === 'mc' && задача2.cue === 'sentence',
      `возврат после последней попытки обязан идти веткой пиявок (mc/sentence), получили ${задача2.format}/${задача2.cue}`)
    assert(задача2.format !== 'type',
      'возврат после последней попытки не должен получать type - формат, который эти слова и проваливали')
  }

  // ---- now = 20.09.2026, до первой попытки (lastAttempt = null) -----------------
  {
    const now = new Date(2026, 8, 20, 10, 0, 0)
    assert(lastAttempt(now) === null, 'предпосылка: 20.09 обязан давать lastAttempt = null (попыток ещё не было)')

    // первый показ после возврата (карантин кончился 05.09, показов с тех пор не было)
    const перваяДоПопыток = карточкаСВозвратом('attribute', '2026-09-05', null)
    assert(leechReturned(перваяДоПопыток, now) === 'first',
      `сетап: карточка обязана дать 'first', получили ${leechReturned(перваяДоПопыток, now)}`)
    const итем3: StudyItem = { view: перваяДоПопыток, skill: 'recall', fsrs: перваяДоПопыток.fsrs }
    const задача3 = pickTask(итем3, [перваяДоПопыток, ...соседи], undefined, undefined, true, false, now)
    assert(задача3.format === 'reveal' && задача3.cue === 'sentence',
      `без единой прошедшей попытки ветка пиявок обязана действовать даже на давнем возврате, получили ${задача3.format}/${задача3.cue}`)

    // возврат совсем недавно (18.09), уже был один показ - тоже ветка пиявок, тоже без popытки
    const позжеДоПопыток = карточкаСВозвратом('buttress', '2026-09-18', new Date(2026, 8, 19, 12, 0, 0))
    assert(leechReturned(позжеДоПопыток, now) === 'later',
      `сетап: карточка обязана дать 'later', получили ${leechReturned(позжеДоПопыток, now)}`)
    const итем4: StudyItem = { view: позжеДоПопыток, skill: 'recall', fsrs: позжеДоПопыток.fsrs }
    const задача4 = pickTask(итем4, [позжеДоПопыток, ...соседи], undefined, undefined, true, false, now)
    assert(задача4.format === 'mc' && задача4.cue === 'sentence',
      `ветка пиявок действует для обеих карточек без прошедшей попытки, получили ${задача4.format}/${задача4.cue}`)
  }

  console.log('  ✓ H3: пиявка возвращается в обычную ротацию после прошедшей попытки, а не только после phase===between')
  passed++
}

/**
 * C13: MAX_LEECH_PER_LESSON ограничивает урок пятью вернувшимися пиявками разом,
 * без потолка урок с девятью такими карточками превращался бы в один и тот же
 * формат подряд. Лишние не выбывают из колоды и из счётчика «повторить»
 * (homeCounts): они просто ждут места в следующем уроке.
 */
function leechCapChecks(): void {
  const now = new Date(BASE)
  const сегодня = dayKey(now)
  const пиявка = (word: string, dueOffsetMs: number): CardView => {
    const v = reviewCard(word, 1, dueOffsetMs)
    v.leech = addDaysKey(сегодня, -8)
    v.fsrs = { ...v.fsrs, last_review: new Date(BASE - 9 * 86400_000) } // все 'first'
    return v
  }
  const пиявки = Array.from({ length: 9 }, (_, i) => пиявка(`пиявка${i}`, -(i + 1) * 3600_000))
  const обычные = Array.from({ length: 20 }, (_, i) => reviewCard(`долг${i}`, 1, -(i + 1) * 7200_000))
  const колода = [...пиявки, ...обычные]

  const очередь1 = buildQueue(колода, 0, now)
  const пиявокВОчереди1 = очередь1.filter(i => leechReturned(i.view, now) !== null)
  assert(пиявокВОчереди1.length === MAX_LEECH_PER_LESSON,
    `урок берёт не больше MAX_LEECH_PER_LESSON (${MAX_LEECH_PER_LESSON}) вернувшихся пиявок за раз, получили ${пиявокВОчереди1.length}`)
  assert(очередь1.length === обычные.length + MAX_LEECH_PER_LESSON,
    `в урок вошли все обычные просроченные плюс потолок пиявок, получили ${очередь1.length} вместо ${обычные.length + MAX_LEECH_PER_LESSON}`)

  assert(homeCounts(колода, 0, now).revDue === колода.length,
    `«повторить» на главном считает весь долг, включая отложенных пиявок: ${homeCounts(колода, 0, now).revDue} вместо ${колода.length}`)

  // отложенные пиявки не выбыли из колоды, они просто не попали в этот урок
  const слаги1 = new Set(очередь1.map(i => i.view.slug))
  const отложенные = пиявки.filter(p => !слаги1.has(p.slug))
  assert(отложенные.length === пиявки.length - MAX_LEECH_PER_LESSON,
    `отложенных пиявок обязано остаться ${пиявки.length - MAX_LEECH_PER_LESSON}, получили ${отложенные.length}`)

  // как только пять взятых пиявок обработаны в отдельном уроке (ушли из состава колоды на
  // повторную выборку), следующий вызов buildQueue подхватывает оставшихся четверых
  const колодаБезВзятых = колода.filter(v => !(v.leech && слаги1.has(v.slug)))
  const очередь2 = buildQueue(колодаБезВзятых, 0, now)
  const пиявокВОчереди2 = очередь2.filter(i => leechReturned(i.view, now) !== null)
  assert(пиявокВОчереди2.length === отложенные.length,
    `следующий урок подхватывает отложенных пиявок целиком: ожидали ${отложенные.length}, получили ${пиявокВОчереди2.length}`)

  console.log(`  ✓ C13: buildQueue берёт не больше ${MAX_LEECH_PER_LESSON} вернувшихся пиявок за урок, остальные ждут своей очереди`)
  passed++

  /* H2 (05.09.2026): потолок стоит на ПЕРВОМ показе после карантина, а не на любом
     вернувшемся. Карантин истёк у всех ('later' карточка не в inRework), но с момента
     возврата уже был показ (last_review позже конца карантина) - такая карточка не в
     счёт MAX_LEECH_PER_LESSON и конкурирует в общем reviewCap на равных с просрочкой. */
  const позжеПиявка = (word: string, dueOffsetMs: number): CardView => {
    const v = reviewCard(word, 1, dueOffsetMs)
    v.leech = addDaysKey(сегодня, -8)
    v.fsrs = { ...v.fsrs, last_review: new Date(BASE - 3600_000) } // конец карантина уже позади -> 'later'
    return v
  }

  // шесть 'later' плюс одна 'first' - потолок не режет ни одной, все семь проходят
  const шестьПозже = Array.from({ length: 6 }, (_, i) => позжеПиявка(`позже${i}`, -(i + 1) * 3600_000))
  const однаПервая = пиявка('перваяОдна', -7200_000)
  {
    const колодаПозже = [...шестьПозже, однаПервая]
    for (const v of шестьПозже) assert(leechReturned(v, now) === 'later', `сетап: карточка обязана дать 'later', получили ${leechReturned(v, now)}`)
    assert(leechReturned(однаПервая, now) === 'first', `сетап: контрольная карточка обязана дать 'first', получили ${leechReturned(однаПервая, now)}`)
    const очередьПозже = buildQueue(колодаПозже, 0, now)
    assert(очередьПозже.length === колодаПозже.length,
      `потолок MAX_LEECH_PER_LESSON не должен резать 'later': ожидали ${колодаПозже.length} карточек в уроке, получили ${очередьПозже.length}`)
  }

  // шесть 'first' - потолок режет до пяти, как и раньше
  const шестьПервых = Array.from({ length: 6 }, (_, i) => пиявка(`перваяШесть${i}`, -(i + 1) * 3600_000))
  {
    const очередьШестьПервых = buildQueue(шестьПервых, 0, now)
    assert(очередьШестьПервых.length === MAX_LEECH_PER_LESSON,
      `потолок MAX_LEECH_PER_LESSON режет 'first' до ${MAX_LEECH_PER_LESSON}, получили ${очередьШестьПервых.length}`)
  }

  console.log('  ✓ H2: потолок MAX_LEECH_PER_LESSON держит только первый показ после карантина, «later» конкурирует в общем reviewCap')
}

/**
 * F82: окна «Подзабылось» получают свой бюджет (REINTRO_PER_LESSON), отдельный от бюджета
 * знакомств новых слов.
 *
 * Регресс на живом журнале 04.09.2026: очередь ставит весь пул Relearning впереди новых
 * (buildQueue), и до правки оба вида окон-знакомств делили один счётчик - провалы съедали его
 * первыми, знакомство новых слов не происходило вовсе (девять окон 'intro' за день, все по
 * старым словам, ноль новых). Колода ниже воспроизводит именно эту форму: провалов больше,
 * чем REINTRO_PER_LESSON, и они стоят в очереди раньше новых слов.
 */
function reintroBudgetChecks(): void {
  const failWords = new Set<string>()
  // уже провалившиеся до сессии (state Relearning) - именно этот пул очередь ставит
  // впереди новых (buildQueue), и именно на нём воспроизводился дефект 04.09.2026
  const провалы: CardView[] = []
  for (let i = 0; i < 6; i++) {
    const v = relearnCard(`провал${i}`)
    failWords.add(v.word)
    провалы.push(v)
  }
  const новые = Array.from({ length: 3 }, (_, i) => newCard(`новое${i}`))
  const deck = [...провалы, ...новые]

  const run = runDay(deck, { budget: 3, introLimit: 3, dayNew: 3, failWords, lessons: 3 })

  for (const [li, shows] of run.lessons.entries()) {
    const tag = `урок ${li + 1}`
    // 1. Окно «Подзабылось» - показ format 'intro' по НЕновому слову (state на момент показа
    //    не New, что и хранит Show.wasNew) - не может быть выдано сверх REINTRO_PER_LESSON.
    const reintroShows = shows.filter(s => s.format === 'intro' && !s.wasNew).length
    assert(reintroShows <= REINTRO_PER_LESSON,
      `[${tag}] бюджет окон «Подзабылось» нарушен: ${reintroShows} > ${REINTRO_PER_LESSON}.\n  ${fmtSeq(shows)}`)

    // 3. Провал сверх бюджета не пропадает: первый показ СЛОВА ПОСЛЕ того, как оно провалилось
    //    (Rating.Again), либо окно (в пределах бюджета), либо обычный формат - но показ есть.
    //    Считаем это только там, где провалов в уроке действительно больше бюджета: иначе
    //    проверка ничего не различает (первый показ карточки Review и так никогда не 'intro').
    const failedKeys = new Set<string>()
    const followups: string[] = []
    for (const s of shows) {
      if (failedKeys.has(s.key)) {
        followups.push(s.format)
        failedKeys.delete(s.key)
      }
      if (s.graded === Rating.Again) failedKeys.add(s.key)
    }
    const windowed = followups.filter(f => f === 'intro').length
    const plain = followups.filter(f => f !== 'intro').length
    assert(windowed <= REINTRO_PER_LESSON,
      `[${tag}] повторных окон «Подзабылось» больше бюджета: ${windowed} > ${REINTRO_PER_LESSON}.\n  ${fmtSeq(shows)}`)
    if (followups.length > REINTRO_PER_LESSON) {
      assert(plain >= 1,
        `[${tag}] провалы сверх бюджета окон обязаны отрабатываться обычным показом: ` +
        `${followups.length} провалившихся слов, окон только ${windowed}, показов не-окном ${plain}.\n  ${fmtSeq(shows)}`)
    }
  }

  // 2. Знакомства новых слов всё же происходят в первом же уроке: до правки провалы съедали
  //    общий лимит целиком, и freshIntros первого урока был бы 0.
  const первыйУрок = run.lessons[0]
  const freshIntros = первыйУрок.filter(s => s.format === 'intro' && s.wasNew).length
  assert(freshIntros >= 1,
    `дефект F82 воспроизведён: знакомств новых слов за первый урок ${freshIntros} (должно быть ≥1).\n  ${fmtSeq(первыйУрок)}`)

  console.log('  ✓ F82: окна «Подзабылось» и знакомства новых слов делят разные бюджеты')
  passed++
}

/**
 * B2 (S4): обязательная отработка введённого сегодня стоит в очереди РАНЬШЕ новых слов.
 *
 * `buildQueue` возвращала `[...learning, ...mixed, ...drills]`, то есть добор шёл последним
 * слагаемым - урок сначала знакомил с новыми словами и лишь потом отрабатывал уже введённые.
 * Приоритет B2 обратный: созревший learning-шаг, просроченный повтор, отработка сегодняшнего,
 * и только затем новое. Проверяем на боевом buildQueue и повторяем прогон: порядок внутри
 * групп перемешан (`shuffle`), а свойство обязано держаться на каждом.
 */
function queueOrderChecks(): void {
  // слово, введённое сегодня: Learning со сроком на завтра (в learning-ветку очереди не
  // попадает - до него дальше LEARN_AHEAD_MS), в урок его тянет только forced
  const drill = learningCard('drill-today', BASE + 20 * 3600_000)
  const deck = [reviewCard('r1'), reviewCard('r2'), reviewCard('r3'), drill,
                newCard('n1'), newCard('n2'), newCard('n3')]
  const forced = new Set([drill.slug])

  for (let i = 0; i < 50; i++) {
    const q = buildQueue(deck, 2, new Date(BASE), forced)
    const slugs = q.map(it => it.view.slug).join(',')
    const drillAt = q.findIndex(it => it.view.slug === drill.slug)
    const newAt = q.map((it, idx) => (it.fsrs.state === State.New ? idx : -1)).filter(idx => idx >= 0)
    assert(drillAt >= 0, `B2: обязательная отработка не попала в очередь: ${slugs}`)
    assert(newAt.length === 2, `B2: при бюджете 2 ожидались два новых слова, получили ${newAt.length}: ${slugs}`)
    assert(newAt.every(idx => drillAt < idx),
      `B2 нарушено: отработка сегодняшнего стоит на #${drillAt}, новое слово - на #${Math.min(...newAt)}: ${slugs}`)
  }

  // без forced очередь прежняя: добор не берётся сам по себе, а состав не меняется
  const plain = buildQueue(deck, 2, new Date(BASE))
  assert(!plain.some(it => it.view.slug === drill.slug),
    'B2: карточка добора попала в очередь без forced - обязательная отработка считается по журналу')
  assert(plain.length === 5 && plain.filter(it => it.fsrs.state === State.New).length === 2,
    `B2: без forced очередь обязана остаться прежней (3 повтора + 2 новых), получили ${plain.map(it => it.view.slug).join(',')}`)

  console.log('  ✓ порядок очереди (B2): обязательная отработка сегодняшнего идёт раньше новых, без forced очередь прежняя')
  passed++
}

/** Повтор с заданной stability - для проверки разгона/закрывающего показа по stability ASC/DESC. */
function reviewCardWithStability(word: string, stability: number, dueOffsetMs = -3600_000): CardView {
  const v = reviewCard(word, 1, dueOffsetMs)
  v.fsrs = { ...v.fsrs, stability }
  return v
}

/** Тот же повтор, но уже спрошенный сегодня (last_review в пределах учебного дня). */
function reviewCardAskedToday(word: string, stability: number, dueOffsetMs = -3600_000): CardView {
  const v = reviewCardWithStability(word, stability, dueOffsetMs)
  v.fsrs = { ...v.fsrs, last_review: new Date(BASE - 3600_000) }
  return v
}

/**
 * B2-bis: разгон урока (warmupShows/buildQueue).
 *
 * Замер: 41-44% Again на первых трёх оценках сессии против 25% по журналу в целом, и 57%
 * брошенных сессий обрываются на Again - урок начинался с самого слабого места (learning
 * по due ASC). Разгон подставляет вперёд до двух самых прочных Review-слов колоды.
 */
function warmupChecks(): void {
  const now = new Date(BASE)

  // 5 learning + 10 review с разной stability, ни одно не спрошено сегодня: голова очереди -
  // ровно две Review-единицы с максимальной stability, обе не спрошены сегодня.
  const learning = Array.from({ length: 5 }, (_, i) => learningCard(`уч${i}`, BASE - i * 1000))
  const review = Array.from({ length: 10 }, (_, i) => reviewCardWithStability(`пов${i}`, 10 - i, -(i + 1) * 3600_000))
  const deck = [...learning, ...review]
  const q = buildQueue(deck, 0, now)
  const head = q.slice(0, WARMUP_SHOWS)
  assert(head.length === WARMUP_SHOWS, `B2-bis: голова очереди обязана содержать ${WARMUP_SHOWS} единицы разгона, получили ${head.length}`)
  assert(head.every(i => i.fsrs.state === State.Review && i.skill === 'recall'),
    `B2-bis: голова очереди обязана состоять из recall-единиц Review, получили ${head.map(i => `${i.view.slug}:${i.skill}:${State[i.fsrs.state]}`).join(',')}`)
  assert(head.every(i => !i.fsrs.last_review || dayKey(i.fsrs.last_review) !== dayKey(now)),
    'B2-bis: голова разгона не должна включать карточку, спрошенную сегодня')
  const headSlugs = head.map(i => i.view.slug).sort()
  assert(JSON.stringify(headSlugs) === JSON.stringify(['пов0', 'пов1']),
    `B2-bis: голова обязана быть двумя самыми прочными Review (пов0, пов1), получили ${headSlugs.join(',')}`)

  // без Review в колоде голова пуста, порядок как раньше: первым идёт learning
  const noReviewDeck = [...learning, newCard('new1'), newCard('new2')]
  const q2 = buildQueue(noReviewDeck, 2, now)
  assert(q2[0].fsrs.state === State.Learning,
    `B2-bis: без Review-кандидатов голова пуста, первым обязан идти learning, получили ${q2[0] && State[q2[0].fsrs.state]}`)

  // спрошенная сегодня карточка (даже с самой высокой stability) в разгон не попадает
  const askedToday = reviewCardAskedToday('спрошено-сегодня', 999)
  const notAsked = reviewCardWithStability('можно-в-разгон', 5)
  const warmupCandidates = warmupShows(expandItems([askedToday, notAsked], now), now)
  assert(!warmupCandidates.some(i => i.view.slug === askedToday.slug),
    'B2-bis: карточка, спрошенная сегодня, не должна попадать в разгон, даже с максимальной stability')
  assert(warmupCandidates.some(i => i.view.slug === notAsked.slug),
    'B2-bis: карточка, не спрошенная сегодня, обязана остаться кандидатом в разгон')

  // голова не больше 2 при любом размере колоды
  for (const size of [0, 1, 2, 3, 30]) {
    const bigDeck = Array.from({ length: size }, (_, i) => reviewCardWithStability(`любая${i}`, size - i))
    const w = warmupShows(expandItems(bigDeck, now), now)
    assert(w.length <= WARMUP_SHOWS, `B2-bis: голова разгона на колоде из ${size} карточек обязана быть не больше ${WARMUP_SHOWS}, получили ${w.length}`)
  }

  // разгон не увеличивает число повторов сверх MAX_REVIEW_PER_LESSON
  const огромный = Array.from({ length: MAX_REVIEW_PER_LESSON + 40 }, (_, i) => reviewCardWithStability(`лимит${i}`, i, -(i + 1) * 3600_000))
  const qЛимит = buildQueue(огромный, 0, now)
  const повторовВсего = qЛимит.filter(i => i.fsrs.state === State.Review).length
  assert(повторовВсего === MAX_REVIEW_PER_LESSON,
    `B2-bis: разгон обязан считаться внутри MAX_REVIEW_PER_LESSON, получили ${повторовВсего} вместо ${MAX_REVIEW_PER_LESSON}`)
  const headЛимит = qЛимит.slice(0, WARMUP_SHOWS).map(i => i.view.slug).sort()
  assert(JSON.stringify(headЛимит) === JSON.stringify(['лимит98', 'лимит99']),
    `B2-bis: даже на переполненной колоде голова обязана быть двумя самыми прочными единицами, получили ${headЛимит.join(',')}`)

  // разгон не меняет состав среза: при просрочке длиннее остатка потолка два самых прочных
  // берутся из самого среза, а недозревшая карточка с огромной stability слот не отнимает
  {
    const ОСТАТОК = 2
    const тесно: CardView[] = [
      reviewCardWithStability('просрочка-а', 1, -3 * 86400_000),
      reviewCardWithStability('просрочка-б', 2, -2 * 86400_000),
      reviewCardWithStability('просрочка-в', 3, -1 * 86400_000),
      reviewCardWithStability('не-срок', 500, 5 * 86400_000),
    ]
    for (let i = 0; i < MAX_REVIEW_PER_DAY - ОСТАТОК; i++) тесно.push(doneTodayCard(`сделано${i}`))
    const qТесно = buildQueue(тесно, 0, now).filter(i => i.fsrs.state === State.Review)
    const slugs = qТесно.map(i => i.view.slug).sort()
    assert(qТесно.length === ОСТАТОК, `B2-bis: срез при тесном потолке равен остатку (${ОСТАТОК}), получили ${qТесно.length}`)
    assert(!slugs.includes('не-срок'), `B2-bis: недозревшая карточка не должна отнимать слот у просрочки, получили ${slugs.join(',')}`)
    assert(JSON.stringify(slugs) === JSON.stringify(['просрочка-а', 'просрочка-б']),
      `B2-bis: состав среза - две самые просроченные, разгон меняет только порядок, получили ${slugs.join(',')}`)
  }
  console.log('  ✓ разгон урока (B2-bis): голова очереди - до двух самых прочных Review, не спрошенных сегодня, в счёте урочного потолка')
  passed++
}

/**
 * B7: закрывающий показ.
 *
 * Урок не должен заканчиваться на провале (57% брошенных сессий обрываются на Again) -
 * `closingShow` даёт одну дополнительную recall-единицу Review с максимальной stability,
 * не показанную в этой сессии и не спрошенную сегодня.
 */
function closingShowChecks(): void {
  const now = new Date(BASE)
  const a = reviewCardWithStability('закрыть-а', 3)
  const b = reviewCardWithStability('закрыть-б', 7)
  const c = reviewCardWithStability('закрыть-в', 5)
  const deck = [a, b, c]

  // все Review в exclude - брать нечего
  const excludeAll = new Set([a, b, c].map(v => `${v.path}#recall`))
  assert(closingShow(deck, now, excludeAll) === null,
    'B7: все Review-кандидаты в exclude - closingShow обязан вернуть null')

  // b исключена (уже показана в сессии) - остаётся max stability среди оставшихся (в)
  const excludeB = new Set([`${b.path}#recall`])
  const picked = closingShow(deck, now, excludeB)
  assert(picked !== null, 'B7: closingShow не должен вернуть null, если есть непоказанный кандидат')
  assert(picked!.view.slug === 'закрыть-в',
    `B7: обязана вернуться самая прочная из непоказанных (закрыть-в), получили ${picked!.view.slug}`)
  assert(picked!.skill === 'recall' && picked!.fsrs.state === State.Review,
    'B7: closingShow обязан вернуть recall-единицу в состоянии Review')

  // спрошенная сегодня в закрывающий показ не попадает
  const askedToday = reviewCardAskedToday('спрошено-сегодня-b7', 100)
  const notAsked = reviewCardWithStability('можно-закрыть', 1)
  const pickedAsked = closingShow([askedToday, notAsked], now, new Set())
  assert(pickedAsked !== null && pickedAsked.view.slug === 'можно-закрыть',
    `B7: спрошенная сегодня карточка не должна выбираться закрывающим показом, получили ${pickedAsked && pickedAsked.view.slug}`)

  console.log('  ✓ закрывающий показ (B7): null, если все Review в exclude, иначе самая прочная непоказанная не спрошенная сегодня')
  passed++
}

/**
 * S10: карточка, которую боевой `advance` в очередь НЕ возвращает, не возвращается и в моке.
 *
 * `requeuePosition` отдаёт null, когда ждать нужно дольше, чем остаток очереди: показывать
 * раньше срока нельзя, так решила модель. Мок передавал этот null прямо в `splice`, а тот
 * приводит его к нулю - карточка вставала в ГОЛОВУ остатка и получала лишний показ.
 * Проваленный повтор уходит в Relearning на десять минут, ждать его в очереди из трёх
 * карточек нечем, значит показ ровно один.
 */
function requeueDropChecks(): void {
  const deck = [reviewCard('s1'), reviewCard('s2'), reviewCard('s3'), reviewCard('flaky')]
  const shows = runSession(deck, { budget: 0, introLimit: 0, failWords: new Set(['flaky']) })
  checkAll(shows, 'S10/возврат-в-очередь')
  const flaky = shows.filter(s => s.path === 'deck/flaky.md')
  assert(flaky.length === 1,
    `S10: карточка, которую очередь принять не может, показана ${flaky.length} раз(а) вместо одного.\n  ${fmtSeq(shows)}`)
  console.log('  ✓ возврат в очередь (S10): null от requeuePosition означает «не возвращать», а не «в начало»')
  passed++
}

/**
 * S11 (A2-bis): пол разрыва после знакомства - половина INTRO_GAP_MS, и показ по нему
 * помечается как аварийный.
 *
 * `Math.min(gap, INTRO_GAP_MS)` делал аварийный проход бессмысленным ровно там, где он нужен:
 * у слова, которому урок только что показал знакомство. Короткий экран (5 c) приближает
 * разрывы, поэтому урок вынужден закрывать первую отработку полом, а не строгим разрывом.
 */
function introFloorChecks(): void {
  assert(INTRO_GAP_FLOOR_MS === INTRO_GAP_MS / 2,
    `A2-bis: пол после знакомства обязан быть половиной строгого разрыва, получили ${INTRO_GAP_FLOOR_MS} при ${INTRO_GAP_MS}`)

  const deck = [reviewCard('concede'), newCard('hypothesis'), newCard('derive'), newCard('imply'),
                newCard('yield'), newCard('viable'), newCard('adhere')]
  const shows = runSession(deck, { budget: 3, introLimit: 3, screenMs: 5_000 })
  checkAll(shows, 'S11/пол-после-знакомства')

  const last = new Map<string, { at: number; format: string }>()
  let found = 0
  for (const s of shows) {
    const prev = last.get(s.key)
    if (prev && prev.format === 'intro' && s.at - prev.at < INTRO_GAP_MS) {
      assert(s.at - prev.at >= INTRO_GAP_FLOOR_MS,
        `S11: первая отработка ${s.key} пришла через ${(s.at - prev.at) / 1000} c - ниже пола`)
      assert(s.byFloor, `S11: показ ${s.key} раньше строгого разрыва не помечен аварийным`)
      found++
    }
    last.set(s.key, { at: s.at, format: s.format })
  }
  assert(found > 0,
    `S11: на коротком экране (5 c) урок обязан хоть раз закрыть первую отработку полом, иначе пол не проверен.\n  ${fmtSeq(shows)}`)
  console.log(`  ✓ пол после знакомства (S11/A2-bis): ${found} отработок закрыто полом ${INTRO_GAP_FLOOR_MS / 1000} c, ниже пола показов нет`)
  passed++
}

/**
 * S2: «Уже знаю это слово» тратит дневную норму новых.
 *
 * Инкремент урочного счётчика знакомств стоял в ветке `g !== Rating.Easy`, мимо которой
 * проходит кнопка «Уже знаю это слово». Слово получало оценку из состояния New (то есть по A7
 * считалось введённым), но остаток дня не уменьшало, и ступень bonusNew вводила сверх нормы
 * ещё одно - NEW_PER_DAY превышался ровно на число «уже знаю» за урок.
 *
 * Колода не из одних новых: два созревших повтора дают уроку материал, на котором лестница
 * добора доходит до ступени bonusNew. На колоде из одних новых урок упирается в A6 раньше,
 * ступень не срабатывает вовсе, и перерасход нормы не воспроизводится - тест был бы зелёным
 * и до правки. Дневная норма 3 при бюджете урока 3 по той же причине: на норме 2 очередь
 * первого урока забирает её целиком и добирать сверх становится нечего.
 */
function knownWordChecks(): void {
  const dayNew = 3
  const knownWords = new Set(['k1'])
  /* Прогонов несколько: состав и порядок очереди перемешаны (`shuffle` в buildQueue), и
     перерасход виден не на каждом раскладе - один прогон ловил бы регресс через раз.
     Свойство проверяется на КАЖДОМ прогоне: дневная норма не превышается никогда. */
  const ПРОГОНОВ = 30
  let сEasy = 0
  let максимум = 0
  for (let run = 0; run < ПРОГОНОВ; run++) {
    // колода собирается заново: runDay мутирует состояние карточек, как store.rateItem
    const deck = [reviewCard('rv1'), reviewCard('rv2'),
      ...['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map(w => newCard(w))]
    const { lessons } = runDay(deck, { budget: 3, introLimit: 3, dayNew, lessons: 2, knownWords })
    lessons.forEach((shows, i) => checkAll(shows, `S2/прогон${run + 1}/урок${i + 1}`))
    if (lessons.flat().some(s => s.path === 'deck/k1.md' && s.graded === Rating.Easy)) сEasy++

    const введено = new Set<string>()
    for (const shows of lessons) for (const s of shows) if (s.wasNew && s.graded !== null) введено.add(s.path)
    максимум = Math.max(максимум, введено.size)
    assert(введено.size <= dayNew,
      `S2: за день оценку из состояния New получили ${введено.size} слов при дневной норме ${dayNew} ` +
      `(${[...введено].join(', ')}). «Уже знаю это слово» не потратило урочный счётчик знакомств, ` +
      `и ступень bonusNew ввела слово сверх нормы.`)
  }
  assert(сEasy > 0,
    'S2: ни в одном прогоне слово из knownWords не дошло до знакомства - проверять нечего, поправьте раскладку колоды')

  console.log(`  ✓ «уже знаю это слово» (S2): ${ПРОГОНОВ} прогонов, Easy на знакомстве в ${сEasy}, ` +
    `за день введено не больше ${максимум} слов при норме ${dayNew}`)
  passed++
}

/**
 * S5 (B4): во втором уроке дня отработка сегодняшнего слова идёт раньше первого знакомства.
 *
 * Свойство держится двумя правками сразу: порядком очереди в buildQueue (drills перед новыми)
 * и порядком ступеней лестницы proceed (батч знакомств A4-bis включается только после того,
 * как строгий проход и недоработанные сегодняшние слова ничего не дали).
 */
function ladderOrderChecks(): void {
  const deck = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].map(w => newCard(w))
  const { lessons } = runDay(deck, { budget: 2, introLimit: 2, lessons: 2 })
  lessons.forEach((shows, i) => checkAll(shows, `S5/урок${i + 1}`))

  const вчерашние = new Set(lessons[0].map(s => s.path))
  const второй = lessons[1]
  const отработка = второй.findIndex(s => вчерашние.has(s.path) && s.format !== 'intro')
  const знакомство = второй.findIndex(s => !вчерашние.has(s.path) && s.format === 'intro')
  assert(отработка >= 0,
    `S5: во втором уроке нет ни одной отработки слов первого урока.\n  ${fmtSeq(второй)}`)
  assert(знакомство >= 0,
    `S5: во втором уроке нет ни одного знакомства с новым словом - сравнивать не с чем.\n  ${fmtSeq(второй)}`)
  assert(отработка < знакомство,
    `S5 нарушено: знакомство нового слова (#${знакомство}) идёт раньше отработки сегодняшнего (#${отработка}).\n  ${fmtSeq(второй)}`)

  console.log(`  ✓ порядок лестницы (S5/B4): во втором уроке отработка сегодняшнего (#${отработка}) раньше знакомства (#${знакомство})`)
  passed++
}

function main(): void {
  console.log('SRS session simulation — A2/A3/A4-bis/A6/B4/C1/C2')

  // ---- репро 25.07: пул отработок пуст или почти пуст --------------------
  // Колода из одних новых, повторов на сегодня нет вообще.
  progressScenario('пустой-пул', [
    newCard('hypothesis'), newCard('derive'), newCard('imply'), newCard('yield'),
    newCard('viable'), newCard('adhere'), newCard('substantial'), newCard('reinforce')
  ], { budget: 3, introLimit: 3 })

  // Буквальный репро: одна созревшая карточка + новые (25.07: concede + 147 новых).
  progressScenario('одна-готовая-карта', [
    reviewCard('concede'), newCard('hypothesis'), newCard('derive'), newCard('imply'),
    newCard('yield'), newCard('viable'), newCard('adhere')
  ], { budget: 3, introLimit: 3 })

  // Пул пуст, но есть повторы на завтра — лестница должна поднять их заполнителями.
  progressScenario('заполнители-из-завтра', [
    tomorrowCard('advocate'), tomorrowCard('dismiss'), tomorrowCard('deter'), tomorrowCard('coherent'),
    newCard('hypothesis'), newCard('derive'), newCard('imply'), newCard('yield')
  ], { budget: 3, introLimit: 3 })

  // ---- прежние сценарии (не должны сломаться) ---------------------------
  scenario('all-new-6', [
    newCard('characterize'), newCard('coherent'), newCard('bias'),
    newCard('compelling'), newCard('concede'), newCard('contest')
  ], { budget: 3, introLimit: 3 })

  scenario('mixed', [
    reviewCard('alpha'), reviewCard('beta'), reviewCard('gamma'), reviewCard('delta'),
    newCard('scrutinize'), newCard('bolster'), newCard('corroborate'), newCard('undermine')
  ], { budget: 3, introLimit: 3 })

  // Малая колода: одно новое + один повтор (тесный случай, где раньше слипалось intro→reveal→type).
  scenario('tiny', [reviewCard('solo'), newCard('nascent')], { budget: 1, introLimit: 1 })

  // C2: одно слово стабильно проваливается — должно выбыть после двух провалов.
  scenario('c2-fail', [
    reviewCard('stable1'), reviewCard('stable2'), reviewCard('flaky'), reviewCard('stable3'),
    newCard('fresh1'), newCard('fresh2')
  ], { budget: 2, introLimit: 2, failWords: new Set(['flaky']) })

  // Только повторы — новых нет.
  scenario('review-only', [
    reviewCard('r1'), reviewCard('r2'), reviewCard('r3'), reviewCard('r4'), reviewCard('r5')
  ], { budget: 0, introLimit: 3 })

  // Единственная карточка в колоде: развести знакомство и отработку нечем (A3) — слово ждёт,
  // но и не «сгорает»: знакомство не показывается вовсе.
  const lone = [newCard('alone')]
  const loneShows = runSession(lone, { budget: 3, introLimit: 3 })
  checkAll(loneShows, 'одна-карточка')
  assert(!loneShows.some(s => s.format === 'intro'),
    `A6: знакомство выдано, хотя разделителя нет: ${fmtSeq(loneShows)}`)
  console.log('  ✓ одна-карточка: знакомство не выдано (A6), слово осталось New')
  passed++

  // ---- рандомизированный батч -------------------------------------------
  const rng = makeRng(20260725)
  const N = 400
  for (let t = 0; t < N; t++) {
    const nRev = Math.floor(rng() * 6)
    const nNew = Math.floor(rng() * 6) + 1
    const nTom = Math.floor(rng() * 3)
    const deck: CardView[] = []
    for (let i = 0; i < nRev; i++) deck.push(reviewCard(`rev${t}_${i}`, 1 + (i % 3)))
    for (let i = 0; i < nTom; i++) deck.push(tomorrowCard(`tom${t}_${i}`, 1 + (i % 3)))
    for (let i = 0; i < nNew; i++) deck.push(newCard(`new${t}_${i}`, 1 + (i % 3)))
    const failWords = new Set<string>()
    if (rng() < 0.5 && deck.length) failWords.add(deck[Math.floor(rng() * deck.length)].word)
    const budget = Math.floor(rng() * 4)
    const introLimit = 1 + Math.floor(rng() * 3)
    const { lessons, bars } = runDay(deck, { budget, introLimit, failWords, lessons: 2 })
    lessons.forEach((shows, i) => checkAll(shows, `rand#${t}/урок${i + 1}`))
    bars.forEach((b, i) => { if (b.length) checkProgress(b, `rand#${t}/урок${i + 1}`) })
  }
  console.log(`  ✓ рандомизированный батч: ${N} дней по 2 урока, инвариант и полоска держат везде`)
  passed++

  progressBarChecks()
  goalProgressChecks()

  queueOrderChecks()
  warmupChecks()
  closingShowChecks()
  ladderOrderChecks()
  requeueDropChecks()
  introFloorChecks()
  knownWordChecks()
  logicSectionChecks()
  sectionBudgetChecks()
  perSectionNormBudgetChecks()
  fillerChecks()
  summaryChecks()
  dontKnowChecks()
  newStopChecks()
  sectionStopChecks()
  ptPriorityChecks()
  fromMarkPriorityChecks()
  markPriorityChecks()
  markGlossesChecks()
  leechFlagChecks()
  afkCapChecks()
  tomorrowCountChecks()
  dailyReviewCapChecks()
  relearnCapChecks()
  overdueCorpusChecks()
  leechQuarantineChecks()
  leechReturnedChecks()
  leechAfterAttemptChecks()
  leechCapChecks()
  reintroBudgetChecks()

  console.log(`\nВсе проверки пройдены (${passed} групп).`)
}

/**
 * Полоска прогресса урока: доходит до конца и не врёт по дороге (репро 21.08.2026).
 *
 * Монотонность проверяется во всех сценариях выше (`checkProgress` в `scenario`,
 * `progressScenario` и рандомизированном батче). Здесь — два свойства, которые монотонность
 * не ловит: урок, доработавший свою очередь, обязан закончиться ровно на 100%, а призрачный
 * шаг (знакомство, которое урок показать не смог) обязан оставить числитель на месте.
 */
function progressBarChecks(): void {
  // 1. Урок, который доводит очередь до конца: последний экран — ровно 100%.
  //    Раньше текущая карточка всегда сидела в знаменателе и никогда в числителе, и урок
  //    из четырёх экранов навсегда заканчивался на 75%.
  const наборы: { tag: string; deck: CardView[]; opts: DayOpts }[] = [
    { tag: 'только повторы', opts: { budget: 0, introLimit: 3 },
      deck: [reviewCard('p1'), reviewCard('p2'), reviewCard('p3'), reviewCard('p4'), reviewCard('p5')] },
    /* B2-bis: разгон (warmupShows) забирает две самые прочные Review-единицы колоды
       под голову очереди - это отъедает две единицы у обычного интерливинга. Пул из
       восьми повторов давал natural learning-requeue слишком короткий хвост для
       второй отработки последнего введённого слова (q12), и урок обрывался на 92,9%,
       не успев дать этот показ. Добавлены ещё два повтора (q13, q14): в реальной
       колоде их всегда с запасом, а сама проверка - про то, что полоска доходит до
       100%, а не про точный размер пула. */
    { tag: 'повторы и новые', opts: { budget: 2, introLimit: 2, dayNew: 2 },
      deck: [reviewCard('q1'), reviewCard('q2'), reviewCard('q3'), reviewCard('q4'),
             reviewCard('q7'), reviewCard('q8'), reviewCard('q9'), reviewCard('q10'),
             reviewCard('q13'), reviewCard('q14'),
             newCard('q5'), newCard('q6'), newCard('q11'), newCard('q12')] },
    { tag: 'один повтор', opts: { budget: 0, introLimit: 0 }, deck: [reviewCard('s1')] }
  ]
  for (const { tag, deck, opts } of наборы) {
    const { lessons, bars } = runDay(deck, opts)
    const кадры = bars[0]
    assert(кадры.length > 0, `[полоска/${tag}] урок не дал ни одного кадра`)
    checkProgress(кадры, `полоска/${tag}`)
    const последний = кадры[кадры.length - 1]
    assert(Math.abs(последний.pct - 1) < 1e-9,
      `[полоска/${tag}] урок из ${lessons[0].length} экранов закончился на ` +
      `${(последний.pct * 100).toFixed(1)}%, а не на 100%`)
  }

  /* 2. Призрачный шаг — кадр знакомства, которого урок показать не может.
        Условие достижимо на старте урока: `buildQueue` кладёт знакомство первым, ещё не
        спрашивая правил показа, а Review рисует голову очереди сразу. При newPerLesson = 1
        на колоде из одних новых разделителя A6 нет (второе новое слово потребовало бы
        второго окна), знакомство не выдаётся — и раньше числитель полоски на этом кадре
        всё равно двигался: урок «проходил» экран, которого ученик не видел.

        Здесь проверяется само условие на боевом `buildQueue`; ответ Review на него —
        `proceed(..., counted = false)` — живёт в экране и в этот стенд не импортируется:
        `runDay` начинает урок тем же `proceed`, что и продолжает, поэтому голова очереди
        у него всегда уже одобрена `pickNext` и призрачному кадру взяться неоткуда.
        Правило «кадр пропуска не двигает числитель» сторожит `checkProgress` во всех
        сценариях, а сам пропуск на живой колоде прогоняется отдельным стендом. */
  const призракКолода = [newCard('g1'), newCard('g2'), newCard('g3'), newCard('g4')]
  const стартовая = buildQueue(призракКолода, 2, new Date(BASE), new Set())
  const стартCtx: OrderCtx = {
    deck: призракКолода, introduced: new Set(), lapsed: new Set(), reintroLeft: REINTRO_PER_LESSON,
    introsLeft: 1, shownTimes: new Map(), drilled: new Map(), introPending: new Set(),
    now: BASE, lastPath: '', lastWasIntro: false, sinceIntro: Number.MAX_SAFE_INTEGER,
    batchIntros: 0, hasFiller: false
  }
  assert(стартовая.length > 0 && screenFormat(стартовая[0], стартCtx) === 'intro',
    'предпосылка призрачного шага: первым в очереди урока стоит знакомство')
  assert(!hasSeparator(стартовая, 0, стартCtx),
    'предпосылка призрачного шага: это знакомство урок выдать не может (нет разделителя A6)')

  console.log(`  ✓ полоска: доходит до 100% (${наборы.length} набора), кадр непоказанного знакомства достижим и числитель не двигает`)
  passed++
}

/**
 * WS5b: цель захода (`ProgressInput.goal`) зажимает знаменатель полоски сверху.
 *
 * Свойства зажима, не покрытые остальными сценариями (там `goal: Infinity` - прежнее
 * поведение):
 *   1. реальный остаток БОЛЬШЕ цели - знаменатель зажат целью, а не точной оценкой;
 *   2. реальный остаток МЕНЬШЕ цели - цель ничего не подменяет, знаменатель точен как раньше.
 * Отдельно - храповик: при зажатой цели рост числителя по ходу урока не даёт полоске
 * откатиться назад (`checkProgress` на прогоне с конечным `goal`, а не только с Infinity).
 *
 * Сценарии 5 и 6 - про единицы измерения: цель задана в УПРАЖНЕНИЯХ и считается от начала
 * ДНЯ, а знаменатель полоски - в ЭКРАНАХ текущего урока. Окно-знакомство даёт экран без
 * упражнения (5), а утренний заход даёт упражнения без экранов этого урока (6); прямое
 * `min(total, goal)` врало и там и там, показывая 100% при счётчике «10 из 12».
 */
function goalProgressChecks(): void {
  const item = (word: string): StudyItem => {
    const view = reviewCard(word)
    return { view, skill: 'recall', fsrs: view.fsrs }
  }
  /* doneToday по умолчанию равен shown: в этой очереди все показы - упражнения (окон нет),
     а урок начат с нуля, поэтому счётчик упражнений дня совпадает с числом показов. Именно
     в этих условиях старая формула `min(goal, ...)` и была верна; сценарии 5-6 ниже берут
     случаи, где единицы расходятся, и там doneToday задаётся явно. */
  const baseInput = (queueLen: number, shown: number, goal: number, doneToday = shown): ProgressInput => ({
    shown,
    doneToday,
    queue: Array.from({ length: queueLen }, (_, i) => item(`q${i}`)),
    pending: [],
    isIntro: () => false,
    introsLeft: 0,
    reintroLeft: 0,
    introduced: new Set(),
    forced: new Set(),
    drilled: new Map(),
    fillerAvailable: false,
    bonusNew: [],
    goal
  })

  // 1. Остаток БОЛЬШЕ цели: 8 карточек в очереди, 2 показа сделано - без цели знаменатель
  //    был бы 10, с целью 5 - ровно 5, числитель 3 (сделано + текущий экран).
  const clamped = lessonProgress(baseInput(8, 2, 5))
  assert(Math.abs(clamped - 3 / 5) < 1e-9,
    `[цель/зажим] ожидалось 3/5=0.6 при goal=5 и точном остатке 10, получено ${clamped}`)

  // 2. Остаток МЕНЬШЕ цели: тот же урок, goal=20 - цель не должна подменять точную оценку.
  const unclamped = lessonProgress(baseInput(8, 2, 20))
  const noGoal = lessonProgress(baseInput(8, 2, Infinity))
  assert(Math.abs(unclamped - noGoal) < 1e-9,
    `[цель/не подменяет] goal=20 при точном остатке 10 изменил долю: ${unclamped} vs ${noGoal}`)

  // 3. Храповик под зажатой целью: по ходу урока очередь укорачивается на одну карточку за
  //    показ (точный остаток не меняется, 10 весь урок), goal=5 держит знаменатель на месте,
  //    а числитель растёт - доля обязана идти только вверх и после достижения 100% там и
  //    оставаться, хотя карточек в колоде вдвое больше цели.
  let floor = 0
  for (let shown = 0; shown <= 8; shown++) {
    const pct = lessonProgress(baseInput(8 - shown, shown, 5))
    assert(pct + 1e-9 >= floor,
      `[цель/храповик] доля откатилась на показе ${shown}: было ${floor}, стало ${pct}`)
    floor = pct
  }
  assert(Math.abs(floor - 1) < 1e-9, `[цель/храповик] урок вдвое длиннее цели не дошёл до 100%: ${floor}`)

  // 4. Тот же клинч на боевой симуляции: колода с доборами и лишним новым словом (та же,
  //    что «повторы и новые» в progressBarChecks) под целью, которая заведомо меньше
  //    точного объёма урока - внешний храповик barNow не должен позволить полоске упасть.
  const deck = [reviewCard('gq1'), reviewCard('gq2'), reviewCard('gq3'), reviewCard('gq4'),
    reviewCard('gq7'), reviewCard('gq8'), reviewCard('gq9'), reviewCard('gq10'),
    reviewCard('gq13'), reviewCard('gq14'),
    newCard('gq5'), newCard('gq6'), newCard('gq11'), newCard('gq12')]
  const { bars } = runDay(deck, { budget: 2, introLimit: 2, dayNew: 2, goal: 6 })
  /* Не переиспользуем checkProgress целиком: его правило «100% только на последнем кадре»
     писано под безграничную (Infinity) оценку и здесь неверно намеренно - цель короче
     урока обязана закрыть полоску РАНЬШЕ конца (это и есть «заход закрыт», см. Summary.tsx),
     а не соврать о недоделанной работе. Годятся только монотонность и диапазон. */
  const clampedBars = bars[0]
  for (let i = 1; i < clampedBars.length; i++) {
    assert(clampedBars[i].pct >= clampedBars[i - 1].pct - 1e-9,
      `[цель/боевая-симуляция] полоска пошла назад на кадре ${i + 1}: ` +
      `${(clampedBars[i - 1].pct * 100).toFixed(1)}% -> ${(clampedBars[i].pct * 100).toFixed(1)}%`)
    assert(clampedBars[i].pct > 0 && clampedBars[i].pct <= 1 + 1e-9,
      `[цель/боевая-симуляция] полоска вне диапазона на кадре ${i + 1}: ${(clampedBars[i].pct * 100).toFixed(1)}%`)
  }
  const last = clampedBars[clampedBars.length - 1]
  assert(Math.abs(last.pct - 1) < 1e-9,
    `[цель/боевая-симуляция] урок длиннее цели (goal=6) не дошёл до 100%: ${(last.pct * 100).toFixed(1)}%`)
  const reachedAt = clampedBars.findIndex(b => b.pct >= 1 - 1e-9)
  assert(reachedAt >= 0 && reachedAt < clampedBars.length - 1,
    '[цель/боевая-симуляция] цель короче урока обязана закрыть полоску раньше последнего кадра')

  /* 5. Окно-знакомство - экран, но не упражнение. Два новых слова (обоим положено окно) и
     шесть повторов при цели дня 6. Старая формула сравнивала ЭКРАНЫ с целью в УПРАЖНЕНИЯХ:
     на шестом экране она выдавала 100%, хотя оценено было только три упражнения, и храповик
     фиксировал эту ложь до конца дня. Проходим урок экран за экраном той же моделью, что и
     сам урок: окно слово не закрывает, оно возвращается отработкой следом. */
  const newItem = (word: string): StudyItem => {
    const view = newCard(word)
    return { view, skill: 'recall', fsrs: view.fsrs }
  }
  const ЦЕЛЬ = 6
  const introduced = new Set<string>()
  let очередь: StudyItem[] = [newItem('gn1'), newItem('gn2'),
    ...Array.from({ length: 6 }, (_, i) => item(`gr${i}`))]
  let показано = 0
  let сделано = 0
  let оконОсталось = 2
  let достигнуто = false
  while (очередь.length) {
    const голова = очередь[0]
    const окно = голова.fsrs.state === State.New && !introduced.has(itemKey(голова))
    const pct = lessonProgress({
      shown: показано,
      doneToday: сделано,
      queue: очередь,
      pending: [],
      isIntro: it => it.fsrs.state === State.New && !introduced.has(itemKey(it)),
      introsLeft: оконОсталось,
      reintroLeft: 0,
      introduced,
      forced: new Set(),
      drilled: new Map(),
      fillerAvailable: false,
      bonusNew: [],
      goal: ЦЕЛЬ
    })
    // упражнений дня к концу ЭТОГО экрана: окно оценки не даёт, отработка даёт
    const послеЭкрана = сделано + (окно ? 0 : 1)
    if (послеЭкрана >= ЦЕЛЬ) {
      assert(Math.abs(pct - 1) < 1e-9,
        `[цель/окна] экран, закрывающий цель (${послеЭкрана} из ${ЦЕЛЬ}), обязан дать 100%, а дал ${(pct * 100).toFixed(1)}%`)
      достигнуто = true
    } else {
      // отработок в очереди хватает на остаток до цели, значит зажим целью обязан работать
      assert(очередь.length >= ЦЕЛЬ - сделано,
        `[цель/окна] предпосылка сценария нарушена: на экране ${показано + 1} в очереди ${очередь.length} отработок при остатке ${ЦЕЛЬ - сделано}`)
      assert(pct < 1 - 1e-9,
        `[цель/окна] 100% на экране ${показано + 1}, когда сделано ${сделано} упражнений из ${ЦЕЛЬ}: ${(pct * 100).toFixed(1)}%`)
    }
    показано++
    if (окно) {
      introduced.add(itemKey(голова))
      оконОсталось--
    } else {
      сделано++
      очередь = очередь.slice(1)
    }
  }
  assert(достигнуто, '[цель/окна] сценарий не дошёл до цели: проверять нечего')

  /* 6. Цель ДНЕВНАЯ, а урок - не весь день. Утренний заход дал 10 упражнений из 12, вечерний
     урок начинается с нуля показов и восьми повторов в очереди: до цели остаётся ровно два
     упражнения, то есть два экрана. Старый зажим не знал о сделанном утром и растягивал
     знаменатель на двенадцать. */
  const вечер = (shown: number, done: number): number => lessonProgress(baseInput(8 - shown, shown, 12, done))
  assert(Math.abs(вечер(0, 10) - 1 / 2) < 1e-9,
    `[цель/дневной остаток] первый экран вечернего захода при 10 из 12 ожидался 1/2, получено ${вечер(0, 10)}`)
  assert(Math.abs(вечер(1, 11) - 1) < 1e-9,
    `[цель/дневной остаток] второй экран закрывает цель и обязан дать 100%, получено ${вечер(1, 11)}`)

  console.log('  ✓ цель захода: знаменатель зажат сверху, не подменяет точный остаток снизу, храповик держит')
  passed++
}

/**
 * Дневной лимит новых карточек считается ПО РАЗДЕЛУ.
 *
 * Репро дефекта, найденного 21.08.2026 на живых данных: лимит был один на всю колоду
 * (`newPerDay − введено за день`), и раздел, который открывали первым, забирал его
 * целиком. За четырнадцать дней «Слова» выбирали норму каждый день, поэтому
 * «Грамматика» (20 карточек) и «Математика» (4) не ввели НИ ОДНОЙ: их блок на главной
 * считал `newAvail = min(новых, 0)`, печатал «Всё повторено» и гасил кнопку поверх
 * нетронутой колоды. Интерфейс не отражал лень владельца — он ему врал.
 */
/**
 * Разборы чтения не попадают в урок слов.
 *
 * Репро дефекта, названного 22.08.2026 на живом занятии: пятнадцать минут в разделе
 * «Слова» дали 41 оценку, из которых 22 — карточки kind error (вопросы к тексту), и
 * только 19 — словарь. Причина была в `sectionOf`: II и CS уезжали в 'rw' к словам,
 * EOI — в 'grammar' к запятым. Проверка идёт от ТОГО ЖЕ отбора, которым живёт урок
 * (Review.tsx фильтрует колоду по `sectionOf(v) === section`), поэтому падает ровно
 * тогда, когда упражнение снова окажется среди слов.
 */
function logicSectionChecks() {
  const разборы = [
    { ...baseView('log-ii-central-idea', 1, 'error'), domain: 'II' },
    { ...baseView('log-cs-cel-teksta', 1, 'error'), domain: 'CS' },
    { ...baseView('log-eoi-cause-not-effect', 1, 'error'), domain: 'EOI' }
  ]
  const слова = [newCard('candid'), newCard('lucid')]
  const грамматика = [{ ...baseView('semicolon', 1, 'grammar'), domain: 'SEC' }]
  const связка = { ...baseView('nevertheless', 1, 'vocab'), pos: 'transition' }
  const математика = [{ ...baseView('quadratic', 1, 'math'), domain: 'ALG' }]
  const колода = [...разборы, ...слова, ...грамматика, связка, ...математика]

  // то, ради чего правка: урок слов состоит из слов
  const урокСлов = колода.filter(v => sectionOf(v) === 'rw')
  assert(урокСлов.length === слова.length,
    `репро: в раздел «Слова» попало лишнее — ${урокСлов.map(v => v.slug).join(', ')}`)
  const урокГрамматики = колода.filter(v => sectionOf(v) === 'grammar')
  assert(урокГрамматики.every(v => v.domain !== 'EOI'),
    'репро: риторический синтез (EOI) остался в разделе «Грамматика»')

  assert(разборы.every(v => sectionOf(v) === 'logic'), 'II, CS и EOI — раздел «Логика»')
  assert(sectionOf(связка) === 'grammar', 'связка-слово остаётся в грамматике, она не разбор текста')
  assert(sectionOf(математика[0]) === 'math', 'математика разделом не сдвинулась')
  assert(SECTIONS.includes('logic'), '«Логика» стоит в перечне разделов — иначе её нет ни в отчёте, ни в «Статистике»')
  assert(SECTION_LABELS.logic.length > 0, 'у раздела есть человеческая подпись')
  // у каждого раздела своя дневная норма новых: разбор не отбирает норму у слова
  assert(newBudgetFor(урокСлов, 3, [], '2026-08-22') === 3, 'норма слов считается по словам')
  assert(newBudgetFor(разборы, 3, [], '2026-08-22') === 3, 'у разборов своя норма')

  console.log('  ✓ разборы чтения (II/CS/EOI) — отдельный раздел «Логика», в уроке слов их нет')
  passed++
}

function sectionBudgetChecks() {
  const день = '2026-08-21'
  const слова = [newCard('alpha'), newCard('beta'), newCard('gamma')]
  const грамматика = [baseView('semicolon', 1, 'grammar'), baseView('dangling', 1, 'grammar')]
  const математика = [baseView('quadratic', 1, 'math')]
  const все = [...слова, ...грамматика, ...математика]

  assert(слова.every(v => sectionOf(v) === 'rw'), 'предпосылка: словарные карточки — раздел «Слова»')
  assert(грамматика.every(v => sectionOf(v) === 'grammar'), 'предпосылка: грамматические карточки — раздел «Грамматика»')
  assert(математика.every(v => sectionOf(v) === 'math'), 'предпосылка: математические карточки — раздел «Математика»')

  // дневная норма (3) выбрана целиком уроком СЛОВ
  const журнал: JournalLine[] = слова.map(v => ({
    id: v.slug, type: 'review', ts: `${день}T10:00:00+04:00`, day: день,
    slug: v.slug, skill: 'recall', prev_state: State.New
  }))

  assert(newBudgetFor(слова, 3, журнал, день) === 0, 'словарь свою дневную норму выбрал')
  assert(newBudgetFor(грамматика, 3, журнал, день) === 3, 'репро: урок слов не съедает дневную норму грамматики')
  assert(newBudgetFor(математика, 3, журнал, день) === 3, 'репро: урок слов не съедает дневную норму математики')

  // …и обратно: введённая грамматическая карточка списывается только со своего раздела
  const журнал2: JournalLine[] = [...журнал, {
    id: 'semicolon', type: 'review', ts: `${день}T11:00:00+04:00`, day: день,
    slug: 'semicolon', skill: 'recall', prev_state: State.New
  }]
  assert(newBudgetFor(грамматика, 3, журнал2, день) === 2, 'введённая грамматика списывается с бюджета грамматики')
  assert(newBudgetFor(слова, 3, журнал2, день) === 0, 'и не возвращает словарю уже потраченное')

  // ровно то место, где дефект был виден глазами: блок раздела на главной
  const общийКотёл = Math.max(0, 3 - журнал.length)   // как считалось ДО правки
  assert(homeCounts(грамматика, общийКотёл, new Date(BASE)).newAvail === 0,
    'репро дефекта: при общем лимите грамматике доступно ноль новых при двух непоказанных')
  assert(homeCounts(грамматика, newBudgetFor(грамматика, 3, журнал, день), new Date(BASE)).newAvail === 2,
    'после правки грамматике доступны обе непоказанные карточки')

  /* Сумма по разделам — ею живут сводка «Статистики» и бейдж на иконке. Остаток раздела
     ограничен тем, что в разделе есть: словарь свою норму выбрал (0), в грамматике две
     непоказанные при норме 3 (2), в математике одна (1). Раньше здесь стояло 6 — сумма
     ГОЛЫХ норм, — и бейдж обещал ввод, которого в колоде нет. */
  assert(newBudgetTotal(все, 3, журнал, день) === 3, 'общий остаток — сумма остатков разделов, каждый по наличию')
  assert(newBudgetTotal([...слова, ...грамматика], 3, журнал, день) === 2,
    'раздел, которого в колоде нет, в общий остаток не добавляет свою норму')

  // чужой день чужую норму не занимает
  assert(newBudgetFor(слова, 3, журнал, '2026-08-22') === 3, 'вчерашние вводы не занимают сегодняшнюю норму')

  // F60: пустой раздел остатка не имеет вовсе, сколько бы ни была норма
  assert(newBudgetFor([], 3, [], день) === 0, 'у пустого раздела (нет карточек) остаток новых - ноль, а не голая норма')
  assert(newBudgetFor([], 3, журнал, день) === 0, 'пустой раздел не получает остаток даже без вводов в журнале сегодня')

  console.log('  ✓ дневной лимит новых считается по разделу, а не одним котлом на колоду')
  passed++
}

/**
 * `newBudgetTotal` со СВОЕЙ нормой у каждого раздела (WS6b: `perDay` принимает функцию
 * от раздела, `norms.ts::newPerDay`, а не только число).
 *
 * Числа фикстуры подобраны так, чтобы результат с функцией и с числом РАЗЛИЧАЛСЯ:
 * при общей норме 3 «Грамматика» (6 новых) срезается той же тройкой, что и «Слова», а со
 * своей нормой (`newPerDay('grammar','norm')` = 8) забирает все 6; «Слова» (12 новых) со
 * своей нормой 10 берут десять, а не три. Числа берутся из norms.ts, а не дублируются в тесте.
 */
function perSectionNormBudgetChecks(): void {
  const день = '2026-08-25'
  const слова = ['kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi']
    .map(w => newCard(w)) // 12 новых - больше нормы словаря, чтобы норма резала, а не размер раздела
  const грамматика = [
    baseView('comma-splice', 1, 'grammar'), baseView('dangling-mod', 1, 'grammar'),
    baseView('subj-verb', 1, 'grammar'), baseView('parallelism', 1, 'grammar'),
    baseView('apostrophe', 1, 'grammar'), baseView('colon-use', 1, 'grammar')
  ] // 6 новых
  const математика = [baseView('parabola', 1, 'math')] // 1 новая
  const логика: CardView[] = [] // 0 новых
  const все = [...слова, ...грамматика, ...математика, ...логика]

  assert(newPerDay('rw', 'norm') === 10 && newPerDay('grammar', 'norm') === 8 && newPerDay('math', 'norm') === 8,
    'предпосылка: нормы взяты из norms.ts::NEW_PER_DAY_BY_SECTION, а не задублированы числом в тесте')

  const perDayFn = (s: Section) => newPerDay(s, 'norm')

  // с функцией: слагаемое раздела - min(новых в разделе, newBudgetFor(раздел, newPerDay(раздел, 'norm'), ...))
  assert(newBudgetTotal(все, perDayFn, [], день) === 10 + 6 + 1 + 0,
    'функция perDay: у каждого раздела своя норма, слагаемое - min(норма раздела, новых в разделе)')

  // журнал уже забрал часть нормы словаря сегодня - остаток словаря падает, у остальных разделов норма своя и не трогается
  const журналСлов: JournalLine[] = слова.slice(0, 2).map(v => ({
    id: v.slug, type: 'review', ts: `${день}T09:00:00+04:00`, day: день,
    slug: v.slug, skill: 'recall', prev_state: State.New
  }))
  assert(newBudgetTotal(все, perDayFn, журналСлов, день) === 8 + 6 + 1 + 0,
    'функция perDay: журнал списывает норму только у своего раздела, у остальных норма не меняется')

  // с числом остаётся прежнее поведение - одна норма на все разделы без учёта таблицы norms.ts
  assert(newBudgetTotal(все, 3, [], день) === 3 + 3 + 1 + 0,
    'число perDay: прежнее поведение сохранено, min(3, новых) по каждому разделу')

  console.log('  ✓ newBudgetTotal с функцией perDay считает свою норму по разделу (norms.ts), с числом - прежнее поведение')
  passed++
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
