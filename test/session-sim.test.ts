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
import type { CardView, StudyItem } from '../src/lib/types'
import {
  buildQueue, makeScheduler, itemKey, NEW_GAP, shouldRequeue, requeuePosition,
  pickFormat, mcDistractors, suggestedGrade, slowThresholdMs, medianForKind, SLOW_FACTOR, hasMeaningHint, earlyFillers, MAX_EARLY_FILLERS, MIN_SHOW_GAP_MS, holdOnIntroDay, LAST_LEARNING_STEP, sharesMeaning,
  MIN_SHOW_GAP_FLOOR_MS, INTRO_GAP_MS, MAX_INTRO_BONUS, nextNewItems, nextCtxIndex, isSeenWord,
  pickTask, meaningDistractors, REVIEW_CYCLE, NEW_STOP_DATE, kindRank, expandItems, freshItems
} from '../src/lib/scheduler'
import { pickNext, hasSeparator, screenFormat, isGiveUp, INTRO_BATCH_MAX, type OrderCtx } from '../src/lib/session'
import { endOfStudyDay } from '../src/lib/daytime'
import { sessionAccuracy, matureRetention } from '../src/lib/journal'
import { isLeech, LEECH_REPS, LEECH_STABILITY_DAYS } from '../src/lib/metrics'

const BASE = new Date(2026, 6, 24, 10, 0, 0).getTime()
const RETENTION = 0.9
const DRILL_PER_SESSION = 2
/** Секунд на экран: реальные показы 25.07 занимали 5–16 c, поэтому разрыв A2 действительно мешает */
const SCREEN_MS = 10_000

// ---- фабрики карточек ----------------------------------------------------

function baseView(word: string, level: number, kind: string): CardView {
  return {
    path: `deck/${word}.md`, slug: word, word, pos: 'adj',
    context: `The ___ moment defined ${word}.`,
    contexts: [`The ___ moment defined ${word}.`, `A second ___ line about ${word}.`],
    meaning_en: `meaning of ${word}`, meaning_ru: `значение ${word}`, roots: '',
    source: 'test', added: '2026-07-20', level, kind,
    domain: '', confusables: [], leech: '', choices: [], answerText: '', answerNum: '',
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
}

interface DayOpts { budget: number; introLimit: number; failWords?: Set<string>; lessons?: number; dayNew?: number }

interface DayRun { lessons: Show[][] }

/**
 * Прогон учебного дня: несколько уроков подряд по одной колоде (состояние карточек мутирует,
 * как в store.rateItem). Зеркалит Review.tsx: тот же контекст выбора, те же обновления
 * introduced/lapsed/sinceIntro/introShown/batchIntros, та же лестница добора proceed
 * (очередь → недоработанные сегодняшние → заполнители → пауза A2 → конец урока).
 */
function runDay(deck: CardView[], opts: DayOpts): DayRun {
  const f = makeScheduler(RETENTION)
  const failWords = opts.failWords ?? new Set<string>()
  const lessonsN = opts.lessons ?? 1
  let now = BASE
  const lessons: Show[][] = []
  const dayNew = opts.dayNew ?? 15
  // эмуляция forcedTodaySlugs: slug → { первый урок со знакомством, уроки с отработкой после него }
  const introAt = new Map<string, number>()
  const practiceAt = new Map<string, Set<number>>()

  for (let lesson = 0; lesson < lessonsN; lesson++) {
    const introduced = new Set<string>()
    const lapsed = new Set<string>()
    let introShown = 0
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

    const forced = (): Set<string> => {
      const out = new Set<string>()
      for (const [slug, at] of introAt) {
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
      deck, introduced, lapsed, reintroAllowed: introShown < introLimit(), introsLeft: introLimit() - introShown,
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

    /** Лестница добора из Review.tsx::proceed. [] = урок закончен. Ожидания нет по построению. */
    function proceed(list: StudyItem[]): StudyItem[] {
      let rest = list
      let pick = pickNext(rest, ctx(rest))
      if (pick.idx < 0) {
        const extra = topUp().filter(i => !deferred.has(i.view.path) && !rest.some(r => itemKey(r) === itemKey(i)))
        if (extra.length) { rest = [...rest, ...extra]; pick = pickNext(rest, ctx(rest)) }
      }
      if (pick.idx < 0) {
        const fill = availableFillers(rest)
        if (fill.length) { rest = [...rest, ...fill]; fillersUsed += fill.length; pick = pickNext(rest, ctx(rest)) }
      }
      if (pick.idx < 0 && freshIntros < dayNew && introBonus < MAX_INTRO_BONUS) {
        const bonus = nextNewItems(deck, new Set(rest.map(itemKey)), 1).filter(i => !deferred.has(i.view.path))
        if (bonus.length) { rest = [...rest, ...bonus]; introBonus += bonus.length; pick = pickNext(rest, ctx(rest)) }
      }
      if (pick.idx < 0) pick = pickNext(rest, ctx(rest), true)   // аварийный пол разрыва
      if (pick.idx < 0) return []
      const q = [...rest]
      if (pick.idx > 0) { const [it] = q.splice(pick.idx, 1); q.unshift(it) }
      return q
    }

    function advance(q: StudyItem[], next: StudyItem | null, insertAt?: number): StudyItem[] {
      let rest = q.slice(1)
      if (deferred.size) rest = rest.filter(i => !deferred.has(i.view.path))
      if (next && !deferred.has(next.view.path)) {
        if (insertAt !== undefined) rest.splice(Math.min(rest.length, insertAt), 0, next)
        else if (shouldRequeue(next.fsrs, new Date(now))) rest.splice(requeuePosition(rest.length, next.fsrs, new Date(now)), 0, next)
      }
      return proceed(rest)
    }

    let queue = buildQueue(deck, opts.budget, new Date(now), forced())
    // старт урока — тот же выбор экрана, что и дальше (иначе первый экран обходил бы инвариант)
    if (queue.length) queue = proceed(queue)
    let guard = 0
    while (queue.length && guard++ < 2000) {
      const head = queue[0]
      const fmt = screenFormat(head, ctx(queue))
      // render-эффект Review: окно-знакомство не показываем, если его нельзя отработать
      if (fmt === 'intro') {
        const freshNew = head.fsrs.state === State.New && !introduced.has(itemKey(head))
        if ((freshNew && introShown >= introLimit()) || !hasSeparator(queue, 0, ctx(queue))) {
          queue = proceed(queue.slice(1))
          continue
        }
      }

      shownTimes.set(itemKey(head), now)
      lastPath = head.view.path
      lastWasIntro = fmt === 'intro'
      if (fmt === 'intro') introPending.add(itemKey(head)); else introPending.delete(itemKey(head))
      shows.push({
        path: head.view.path, format: fmt, skill: head.skill, graded: null, at: now, key: itemKey(head),
        reps: head.fsrs.reps, wasNew: head.fsrs.state === State.New
      })
      const show = shows[shows.length - 1]
      now += SCREEN_MS

      if (fmt === 'intro') {
        introShown++
        if (head.fsrs.state === State.New) freshIntros++
        lapsed.delete(itemKey(head))
        introduced.add(itemKey(head))
        sinceIntro = 0
        batchIntros++
        if (!introAt.has(head.view.slug)) introAt.set(head.view.slug, lesson)
        queue = advance(queue, head, 2)
        continue
      }

      const willFail = failWords.has(head.view.word)
      const g: Grade = willFail ? Rating.Again : Rating.Good
      show.graded = g

      let rated = f.next(head.fsrs, new Date(now), g).card
      // A1 (зеркалит store.rateItem): слово, введённое сегодня, не выходит в Review внутри дня —
      // держим в Learning со сроком на следующий учебный день. Без этого мок расходился с
      // приложением: слова уезжали в Review и выпадали из обязательной отработки.
      const introToday = introAt.has(head.view.slug)
      const wasIntroState = head.fsrs.state !== State.Review
      if (rated.state === State.Review && wasIntroState && introToday) {
        rated = { ...rated, state: State.Learning, due: endOfStudyDay(new Date(now)) }
      }
      head.view.fsrs = rated // зеркалит store.rateItem: обновление состояния карточки в колоде
      sinceIntro++
      batchIntros = 0
      drilled.set(itemKey(head), (drilled.get(itemKey(head)) ?? 0) + 1)
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
    now += 30 * 60000 // пауза между уроками
  }
  return { lessons }
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
 * A2 — между двумя показами одной единицы не меньше минуты; аварийный пол 30 c допустим
 * только когда уроку было нечего показать вместо этой карточки (лестница добора пуста).
 * Пол проверяем жёстко, число показов в окне 30–60 c печатаем: раньше вместо такого показа
 * рисовался экран ожидания с отсчётом, и это оказалось хуже, чем показ на тридцатой секунде.
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
      const need = afterIntro ? INTRO_GAP_MS : MIN_SHOW_GAP_FLOOR_MS
      assert(gap >= need,
        `[${tag}] A2 нарушено: ${s.key} показан через ${gap / 1000} c (минимум ${need / 1000} c).\n  ${fmtSeq(shows)}`)
      if (!afterIntro && gap < MIN_SHOW_GAP_MS) byFloor++
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

// ---- сценарии ------------------------------------------------------------

let passed = 0
function scenario(tag: string, deck: CardView[], opts: DayOpts): void {
  const shows = runSession(deck, opts)
  const byFloor = checkAll(shows, tag)
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
  const { lessons } = runDay(deck, { ...opts, lessons: 3 })
  const byFloor = lessons.reduce((a, shows, i) => a + checkAll(shows, `${tag}/урок${i + 1}`), 0)
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
  assert(REVIEW_CYCLE[0].format === 'mc' && REVIEW_CYCLE[0].cue === 'sentence',
    'C8: первым идёт формат реального экзамена — Words in Context')
  const modes = [0, 1, 2, 3].map(r => atReps(r))
  const sig = (m: { format: string; cue: string }) => `${m.format}/${m.cue}`
  assert(new Set(modes.map(sig)).size === 4, `C8: четыре подряд показа обязаны дать четыре разных режима: ${modes.map(sig).join(', ')}`)
  assert(modes.filter(m => m.cue === 'sentence').length === 1,
    `C8: предложение показывается ровно на одном шаге из четырёх, иначе оно заучивается: ${modes.map(sig).join(', ')}`)
  assert(modes.some(m => m.format === 'type'),
    'C8: производство обязано быть в цикле — это единственный режим, где угадывать не из чего')
  assert(modes.some(m => m.cue === 'word'),
    'C8: обратный режим (слово → значение) обязан быть в цикле — в нём узнавание английской формы не помогает')
  assert(sig(atReps(4)) === sig(atReps(0)) && sig(atReps(7)) === sig(atReps(3)),
    'C8: цикл замыкается по числу оценок, фаза не плавает')

  // деградация: недоступный шаг заменяется ближайшим возможным, а не пропускается
  const noMeaning: CardView = { ...cycDeck[0], meaning_ru: '', meaning_en: '' }
  for (const r of [1, 2, 3]) {
    assert(atReps(r, noMeaning).cue === 'sentence',
      `C8: без значения шаг ${r} обязан откатиться к предложению, а не спрашивать пустоту`)
  }
  assert(atReps(3, noMeaning).format === 'mc', 'C8: без значения ввод неоднозначен — остаётся выбор')
  assert(atReps(3, cycDeck[0], false).format === 'mc' && atReps(3, cycDeck[0], false).cue === 'meaning',
    'C8: при выключенном вводе шаг производства деградирует в выбор с той же целью, а не пропускается')

  /* Дистракторы-значения: узнавание по новизне здесь не работает в принципе, но
     работает семантическая далёкость — если варианты из разных смысловых зон,
     ответ виден без знания слова. Поэтому берутся значения слов той же части речи. */
  const md = meaningDistractors(cycDeck[0], cycDeck)
  assert(md.length === 3, `C8: ожидалось 3 дистрактора-значения, получено ${md.length}`)
  assert(!md.includes(cycDeck[0].meaning_ru), 'C8: правильное значение не попадает в собственные дистракторы')
  assert(new Set(md).size === md.length, 'C8: значения без повторов')
  assert(atReps(2, cycDeck[0]).cue === 'word', 'C8: на живой колоде обратный режим собирается')
  // колода, где значений на дистракторы не хватает: обратный режим невозможен → откат к значению
  const poorDeck: CardView[] = [cycDeck[0], ...cycDeck.slice(1).map(c => ({ ...c, meaning_ru: '' }))]
  const poorFsrs = { ...cycDeck[0].fsrs, state: State.Review, reps: 2 }
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
  assert(new Set(learnModes.map(sig)).size === 4,
    `C9: со второго повтора learning идёт по тому же циклу: ${learnModes.map(sig).join(', ')}`)
  assert(learnModes.some(m => m.format === 'type'),
    'C9: слово, застрявшее в learning, обязано хоть раз спрашиваться без вариантов — иначе оно тренирует только узнавание')
  assert(inLearning(3, false).format === 'mc',
    'C9: при выключенном вводе шаг производства деградирует, а не пропадает вместе с ротацией')

  // ---- C3: «не помню» = Again, оценка не поднимается выше ----
  const giveUpRating = Rating.Again // именно это фиксирует giveUp() в UI
  for (const f of ['reveal', 'type', 'mc', 'prep'] as const) {
    // reveal → в UI считается как 'type' (объективный сигнал ввода); для остальных формат тот же
    const g = suggestedGrade(f === 'reveal' ? 'type' : f, false, false)
    assert(g === Rating.Again, `C3: пустой/неверный ${f} даёт Again, а не ${g}`)
  }
  assert(giveUpRating <= Rating.Again, 'C3: «не помню» не выдаёт оценку выше Again')

  // ---- C4: пустой/пробельный ввод эквивалентен «не помню» ----
  assert(isGiveUp('') && isGiveUp('   ') && isGiveUp('\t\n'), 'C4: пустое/пробельное поле = «не помню»')
  assert(!isGiveUp('bias'), 'C4: непустой ввод — не «не помню»')
  // и пустой ввод, и кнопка «не помню» идут одним путём → одна и та же оценка
  const emptyRating = isGiveUp('') ? giveUpRating : suggestedGrade('type', false, false)
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
  assert(suggestedGrade('mc', true, false, 20_000, 'vocab', 7412) === Rating.Hard,
    '20 c при медиане 7,4 c — это Hard')
  assert(suggestedGrade('mc', true, false, 20_000, 'vocab') === Rating.Good,
    'та же скорость на прежней константе давала Good — репро дефекта')

  /* Порог по ВИДУ карточки. Репро дефекта, из-за которого один и тот же вопрос
     разбора попадался пятый раз: общая медиана — это медиана словарных ответов
     (447 строк журнала из 464), а карточка разбора требует прочитать условие с
     таблицей и четыре длинных варианта. Замер 21.08.2026: словарные — медиана
     8,1 с, разбор (kind error) — 21,6 с при p90 43,6 с; 53% ответов на разбор
     уходили в Hard против 12% у словарных. Hard в состоянии Learning не двигает
     ступень, и карточка возвращалась в каждый следующий урок. */
  assert(suggestedGrade('mc', true, false, 21_600, 'vocab', 8360) === Rating.Hard,
    'репро: 21,6 с по словарной мерке — заминка, и разбор судился именно ею')
  assert(suggestedGrade('mc', true, false, 21_600, 'error', 8360) === Rating.Good,
    'тот же ответ на карточке разбора — обычный: у неё свой пол')
  assert(suggestedGrade('mc', true, false, 21_600, 'error', 21_649) === Rating.Good,
    'и на своей набранной медиане — тоже обычный, карточка выпускается из Learning')
  assert(slowThresholdMs('error', 8360) >= 45_000,
    'порог: у разбора свой пол — иначе холодный старт наказывает длинное условие')
  assert(slowThresholdMs('error', 21_649) === Math.round(21_649 * SLOW_FACTOR),
    'порог: набралась своя медиана — считаем от неё, а не от пола')
  assert(suggestedGrade('mc', true, false, 60_000, 'error', 21_649) === Rating.Hard,
    'минута на карточку разбора — всё-таки заминка, Hard не должен исчезнуть совсем')
  assert(slowThresholdMs('math', 7412) === 90_000, 'порог математики от правки не сдвинулся')

  /* Своя медиана берётся, только когда её есть на чём считать. */
  const speedFix = {
    medianMs: 8360,
    byKind: { vocab: { medianMs: 8147, n: 447 }, error: { medianMs: 21_649, n: 15 }, math: { medianMs: 23_898, n: 2 } }
  }
  assert(medianForKind(speedFix, 'error') === 21_649, 'медиана вида берётся, когда набралось наблюдений')
  assert(medianForKind(speedFix, 'math') === 8360, 'на двух наблюдениях медиана вида — шум, берём общую')
  assert(medianForKind(speedFix, 'grammar') === 8360, 'вида в журнале нет — общая медиана')

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
    const f = makeScheduler(0.9)
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
  assert(sessionAccuracy({ reviews: 4, again: 4 }) === 0, 'итоги: все провалы — 0%, а не null')
  console.log('  ✓ итоги урока: точность по всем оценкам (репро 25.07: 41 оценка/12 «Заново» → 71%, не 100%)')
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
  assert(kindRank(grammarCard) < kindRank(ptWords[0]), 'kindRank: pt-слово идёт ПОСЛЕ grammar')
  assert(kindRank(ptWords[0]) < kindRank(mathCard), 'kindRank: pt-слово идёт ДО math')
  assert(kindRank(ptWords[0]) < kindRank(routineWord), 'kindRank: pt-слово опережает рутинный словарь независимо от уровня')

  const deck = [errorCard, grammarCard, mathCard, routineWord, ...ptWords]
  const order = freshItems(expandItems(deck)).map(i => i.view.slug)
  assert(order.indexOf('rule-dash-vs-colon') < order.indexOf('comma-rule'), 'freshItems: error раньше grammar')
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
 * Задача 3 (17.08.2026) — починка флага пиявки. Старое условие в store.rateItem
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
    const { lessons } = runDay(deck, { budget, introLimit, failWords, lessons: 2 })
    lessons.forEach((shows, i) => checkAll(shows, `rand#${t}/урок${i + 1}`))
  }
  console.log(`  ✓ рандомизированный батч: ${N} дней по 2 урока, инвариант держит везде`)
  passed++

  fillerChecks()
  summaryChecks()
  dontKnowChecks()
  newStopChecks()
  ptPriorityChecks()
  leechFlagChecks()

  console.log(`\nВсе проверки пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
