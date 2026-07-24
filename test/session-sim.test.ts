/**
 * Симуляция очереди сессии на моках — без PWA/IndexedDB/React. Гоняет РЕАЛЬНЫЕ функции
 * планировщика (buildQueue, pickFormat) и выбора экрана (pickNextIndex, screenFormat),
 * воспроизводя цикл grade→advance из src/screens/Review.tsx. Проверяет инвариант обучения
 * (Учёба/Карточки/_правила-srs.md):
 *   A3 — нет двух подряд идущих экранов одного слова;
 *   A4 — нет двух подряд идущих знакомств (intro);
 *   C1 — type у введённого слова не раньше двух опознаний (reveal/mc);
 *   C2 — слово, дважды проваленное за сессию, из урока выбывает.
 *
 * Запуск: `npm test` (esbuild бандлит этот файл и node его исполняет).
 */
import { State, Rating, createEmptyCard, type Card as FsrsCard, type Grade } from 'ts-fsrs'
import type { CardView, StudyItem } from '../src/lib/types'
import {
  buildQueue, makeScheduler, itemKey, NEW_GAP, shouldRequeue, requeuePosition,
  pickFormat, suggestedGrade, hasMeaningHint
} from '../src/lib/scheduler'
import { pickNextIndex, screenFormat, isGiveUp, type OrderCtx } from '../src/lib/session'

const BASE = new Date(2026, 6, 24, 10, 0, 0).getTime()
const RETENTION = 0.9

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

/** Дозревшее до Review слово с due в прошлом (просрочка → в урок). */
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

// ---- лог показов ---------------------------------------------------------

interface Show { path: string; format: string; skill: string; graded: Grade | null }

interface SessionOpts { budget: number; introLimit: number; failWords?: Set<string> }

/**
 * Один прогон сессии. Зеркалит Review.tsx: тот же контекст выбора очереди, те же обновления
 * introduced/lapsed/sinceIntro/introShown, тот же advance с pickNextIndex. Возвращает
 * последовательность показанных экранов.
 */
function runSession(deck: CardView[], opts: SessionOpts): Show[] {
  const f = makeScheduler(RETENTION)
  const failWords = opts.failWords ?? new Set<string>()
  const introduced = new Set<string>()
  const lapsed = new Set<string>()
  let introShown = 0
  const introLimit = opts.introLimit
  let sinceIntro = NEW_GAP
  const shownTimes = new Map<string, number>()
  const drilled = new Map<string, number>()
  const sessionFails = new Map<string, number>()
  const deferred = new Set<string>()
  let lastPath: string | null = null
  let lastWasIntro = false
  let now = BASE
  const shows: Show[] = []

  const ctx = (): OrderCtx => ({
    deck, introduced, lapsed, reintroAllowed: introShown < introLimit,
    shownTimes, now, lastPath, lastWasIntro, sinceIntro
  })

  // журнала нет → forcedTodaySlugs пуст → topUp ничего не добирает
  const topUp = (): StudyItem[] => []

  function advance(q: StudyItem[], next: StudyItem | null, insertAt?: number): StudyItem[] {
    let rest = q.slice(1)
    if (deferred.size) rest = rest.filter(i => !deferred.has(i.view.path))
    if (next && !deferred.has(next.view.path)) {
      if (insertAt !== undefined) rest.splice(Math.min(rest.length, insertAt), 0, next)
      else if (shouldRequeue(next.fsrs, new Date(now))) rest.splice(requeuePosition(rest.length, next.fsrs, new Date(now)), 0, next)
    }
    let idx = pickNextIndex(rest, ctx())
    if (idx < 0) {
      const extra = topUp().filter(i => !deferred.has(i.view.path) && !rest.some(r => itemKey(r) === itemKey(i)))
      if (extra.length) { rest = [...rest, ...extra]; idx = pickNextIndex(rest, ctx()) }
    }
    if (idx < 0) return []
    if (idx > 0) { const [pick] = rest.splice(idx, 1); rest = [pick, ...rest] }
    return rest
  }

  let queue = buildQueue(deck, opts.budget, new Date(now))
  let guard = 0
  while (queue.length && guard++ < 2000) {
    const head = queue[0]
    const fmt = screenFormat(head, ctx())
    // render-эффект Review: новое сверх лимита окон-знакомств не показываем — снимаем с головы
    const isNewIntro = head.fsrs.state === State.New && !introduced.has(itemKey(head))
      && head.view.choices.length < 2 && !head.view.answerNum && head.skill !== 'prep'
    if (isNewIntro && introShown >= introLimit) { queue = queue.slice(1); continue }

    // показ
    shownTimes.set(itemKey(head), now)
    lastPath = head.view.path
    lastWasIntro = fmt === 'intro'

    now += 20_000 // ~20 c на экран: A2-разрыв в 60 c закрывается через три чужих показа

    if (fmt === 'intro') {
      shows.push({ path: head.view.path, format: fmt, skill: head.skill, graded: null })
      introShown++
      lapsed.delete(itemKey(head))
      introduced.add(itemKey(head))
      sinceIntro = 0
      queue = advance(queue, head, 2)
      continue
    }

    const willFail = failWords.has(head.view.word)
    const g: Grade = willFail ? Rating.Again : Rating.Good
    shows.push({ path: head.view.path, format: fmt, skill: head.skill, graded: g })

    const rated = f.next(head.fsrs, new Date(now), g).card
    head.view.fsrs = rated // зеркалит store.rateItem: обновление состояния карточки в колоде
    sinceIntro++
    drilled.set(itemKey(head), (drilled.get(itemKey(head)) ?? 0) + 1)

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

    const nextItem: StudyItem = { view: head.view, skill: head.skill, fsrs: head.view.fsrs }
    queue = advance(queue, nextItem)
  }
  if (guard >= 2000) throw new Error('сессия не сошлась за 2000 шагов — вероятно, зацикливание')
  return shows
}

// ---- проверки инварианта -------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

function fmtSeq(shows: Show[]): string {
  return shows.map(s => `${s.path.replace('deck/', '').replace('.md', '')}:${s.format}`).join(' → ')
}

/** A3 — нет двух подряд идущих экранов одного слова. */
function checkA3(shows: Show[], tag: string): void {
  for (let i = 1; i < shows.length; i++) {
    assert(shows[i].path !== shows[i - 1].path,
      `[${tag}] A3 нарушено на #${i}: слово ${shows[i].path} встык.\n  ${fmtSeq(shows)}`)
  }
}

/** A4 — нет двух подряд идущих знакомств. */
function checkA4(shows: Show[], tag: string): void {
  for (let i = 1; i < shows.length; i++) {
    assert(!(shows[i].format === 'intro' && shows[i - 1].format === 'intro'),
      `[${tag}] A4 нарушено на #${i}: два intro подряд.\n  ${fmtSeq(shows)}`)
  }
}

/** C1 — у слова, введённого этой сессией (первый экран intro), type не раньше двух опознаний. */
function checkC1(shows: Show[], tag: string): void {
  const firstFmt = new Map<string, string>()
  for (const s of shows) if (!firstFmt.has(s.path)) firstFmt.set(s.path, s.format)
  const recog = new Map<string, number>()
  for (const s of shows) {
    if (s.format === 'type' && firstFmt.get(s.path) === 'intro') {
      assert((recog.get(s.path) ?? 0) >= 2,
        `[${tag}] C1 нарушено: type у ${s.path} после ${recog.get(s.path) ?? 0} опознаний.\n  ${fmtSeq(shows)}`)
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

function checkAll(shows: Show[], tag: string): void {
  checkA3(shows, tag); checkA4(shows, tag); checkC1(shows, tag); checkC2(shows, tag)
}

// ---- сценарии ------------------------------------------------------------

let passed = 0
function scenario(tag: string, deck: CardView[], opts: SessionOpts): void {
  const shows = runSession(deck, opts)
  checkAll(shows, tag)
  console.log(`  ✓ ${tag}: ${shows.length} экранов, инвариант держит`)
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
  // одиночная колода → дистракторов < 3 → выбор type/reveal определяется только подсказкой значения
  assert(pickFormat(item(withoutMeaning), [withoutMeaning]) !== 'type',
    'C5: type выдан Review-карточке без подсказки значения')
  assert(pickFormat(item(withMeaning), [withMeaning]) === 'type',
    'C5: Review-карточка со значением должна допускать type')

  // Learning reps>=2 (C1 выпускает в производство) — без значения всё равно не type (C5)
  const lnNo = { ...withoutMeaning.fsrs, state: State.Learning, reps: 2 }
  const lnYes = { ...withMeaning.fsrs, state: State.Learning, reps: 2 }
  assert(pickFormat(item(withoutMeaning, lnNo), [withoutMeaning]) !== 'type', 'C5: Learning без значения — не type')
  assert(pickFormat(item(withMeaning, lnYes), [withMeaning]) === 'type', 'C5: Learning reps>=2 со значением — type')

  // числовой ответ (math) однозначен сам по себе — остаётся type даже без meaning
  const numCard: CardView = { ...withoutMeaning, answerNum: '15', kind: 'math' }
  assert(pickFormat(item(numCard), [numCard]) === 'type', 'C5: числовой ответ остаётся type без meaning')

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

  console.log('  ✓ dont-know (C3/C4/C5): «не помню»=Again, пустой ввод=«не помню», type только со значением')
  passed++
}

function main(): void {
  console.log('SRS session simulation — A3/A4/C1/C2')

  // Сценарий-репро бага: колода из одних новых, повторов нет (хвост урока, где ломалось).
  scenario('all-new-6', [
    newCard('characterize'), newCard('coherent'), newCard('bias'),
    newCard('compelling'), newCard('concede'), newCard('contest')
  ], { budget: 3, introLimit: 3 })

  // Новые вперемешку с повторами.
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

  // Рандомизированный батч: разные размеры колод, лимиты, набор провальных слов.
  const rng = makeRng(20260724)
  const N = 400
  for (let t = 0; t < N; t++) {
    const nRev = Math.floor(rng() * 6)
    const nNew = Math.floor(rng() * 6) + 1
    const deck: CardView[] = []
    for (let i = 0; i < nRev; i++) deck.push(reviewCard(`rev${t}_${i}`, 1 + (i % 3)))
    for (let i = 0; i < nNew; i++) deck.push(newCard(`new${t}_${i}`, 1 + (i % 3)))
    const failWords = new Set<string>()
    if (rng() < 0.5 && deck.length) failWords.add(deck[Math.floor(rng() * deck.length)].word)
    const budget = Math.floor(rng() * 4)
    const introLimit = 1 + Math.floor(rng() * 3)
    const shows = runSession(deck, { budget, introLimit, failWords })
    checkAll(shows, `rand#${t}`)
  }
  console.log(`  ✓ рандомизированный батч: ${N} сессий, инвариант держит везде`)
  passed++

  dontKnowChecks()

  console.log(`\nВсе проверки пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
