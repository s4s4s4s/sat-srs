import { fsrs, generatorParameters, Rating, State, type Grade, type Card as FsrsCard, type FSRS } from 'ts-fsrs'
import type { CardView, Format, StudyItem } from './types'
import { endOfStudyDay, dayKey, addDaysKey } from './daytime'

export function makeScheduler(requestRetention: number): FSRS {
  // fuzz разводит одновременно выученные карточки по разным дням — меньше комков и MC-соседей
  return fsrs(generatorParameters({ request_retention: requestRetention, enable_fuzz: true }))
}

/** Экзамен и потолок интервалов: всё должно вернуться на повтор до SAT.
    07.11 — суперскор-попытка (реально зачитываемый балл); конфиг покрывает и диагностическую 03.10.
    Решение А. 23.07 (см. [[План SRS-уровни]] · [[Метрики]]). */
export const EXAM_DATE = new Date(2026, 10, 7)   // 07.11.2026, локально
export const DUE_CAP = new Date(2026, 9, 31)     // 31.10.2026

/** Последние 2 недели перед экзаменом — retention поднимается до 0.95 */
export function effectiveRetention(base: number, now: Date = new Date()): number {
  const days = (EXAM_DATE.getTime() - now.getTime()) / 86400_000
  return days >= 0 && days <= 14 ? Math.max(base, 0.95) : base
}

export const GRADES: { rating: Grade; key: string; label: string }[] = [
  { rating: Rating.Again, key: '1', label: 'Заново' },
  { rating: Rating.Hard, key: '2', label: 'Трудно' },
  { rating: Rating.Good, key: '3', label: 'Хорошо' },
  { rating: Rating.Easy, key: '4', label: 'Легко' }
]

/** Человекочитаемый прогноз интервала для кнопки оценки */
export function intervalLabel(f: FSRS, card: FsrsCard, rating: Grade, now: Date): string {
  const next = f.repeat(card, now)[rating].card
  const ms = next.due.getTime() - now.getTime()
  const min = Math.round(ms / 60000)
  if (min < 60) return `${Math.max(1, min)} мин`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} ч`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} дн`
  const mo = d / 30.44
  if (mo < 12) return `${mo.toFixed(mo < 3 ? 1 : 0)} мес`
  return `${(d / 365.25).toFixed(1)} г`
}

const isLearning = (s: State) => s === State.Learning || s === State.Relearning

/** Раздел: слова/RW отдельно от математики — межпредметного перемешивания нет,
    interleaving работает внутри раздела (домены математики перемешаны между собой) */
export type Section = 'rw' | 'grammar' | 'math'
const MATH_DOMAINS = new Set(['ALG', 'AM', 'PSDA', 'GEO'])
export function sectionOf(v: CardView): Section {
  if (v.kind === 'math' || MATH_DOMAINS.has(v.domain)) return 'math'
  // грамматика: пунктуация/правила SEC + связки/логика EOI — отдельно от словаря
  if (v.kind === 'grammar' || v.domain === 'SEC' || v.domain === 'EOI' || v.pos === 'transition') return 'grammar'
  return 'rw'
}

/** Приоритет типа при выборе новых: error/grammar (доказанные пробелы) → math → словарь */
export function kindRank(v: CardView): number {
  const r: Record<string, number> = { error: 0, grammar: 1, math: 2 }
  return r[v.kind] ?? 3
}

/** Карточка, которой управляет система уровней: словарь без связок. Только у неё осмыслен level. */
export function isLevelled(v: CardView): boolean {
  return v.kind === 'vocab' && v.pos !== 'transition'
}

/**
 * Текущий активный уровень: минимальный уровень со ещё не введёнными (New) словами.
 * Все ранние уровни введены → берём максимальный существующий (новые слова падают к последнему).
 * Уровней нет вовсе → 1. Используется для штампа level в самодобавленные карточки и для UI.
 */
export function activeLevel(cards: CardView[]): number {
  const levelled = cards.filter(c => !c.suspended && isLevelled(c) && c.level < 999)
  if (!levelled.length) return 1
  const fresh = levelled.filter(c => c.fsrs.state === State.New)
  if (fresh.length) return Math.min(...fresh.map(c => c.level))
  return Math.max(...levelled.map(c => c.level))
}

export interface LevelStat { level: number; total: number; introduced: number; review: number }

/** Прогресс по уровням для экрана «Путь»: сколько слов покинуло New (introduced) и ушло в Review (mastery). */
export function levelStats(cards: CardView[]): LevelStat[] {
  const m = new Map<number, LevelStat>()
  for (const c of cards) {
    if (c.suspended || !isLevelled(c) || c.level >= 999) continue
    const e = m.get(c.level) ?? { level: c.level, total: 0, introduced: 0, review: 0 }
    e.total++
    if (c.fsrs.state !== State.New) e.introduced++
    if (c.fsrs.state === State.Review) e.review++
    m.set(c.level, e)
  }
  return [...m.values()].sort((a, b) => a.level - b.level)
}

/** Learning-карточки показываем чуть раньше срока (Anki learn-ahead), чтобы шаг не терялся на конце сессии/дня */
export const LEARN_AHEAD_MS = 30 * 60000

/**
 * Минимум отработок между знакомствами с новыми словами.
 * Новые подряд грузят рабочую память и мешают друг другу (interference):
 * слово должно быть хотя бы раз извлечено, прежде чем в голову зайдёт следующее.
 */
export const NEW_GAP = 2

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Развёртка колоды в учебные единицы (карточка × навык).
 * prep-навык подключается, когда слово уже знакомо (recall в Review) —
 * или сразу, если prep-график уже начат (не бросаем начатое).
 */
export function expandItems(cards: CardView[]): StudyItem[] {
  const items: StudyItem[] = []
  for (const c of cards) {
    if (c.suspended) continue
    items.push({ view: c, skill: 'recall', fsrs: c.fsrs })
    if (c.prep && c.fsrsPrep) {
      const started = c.fsrsPrep.state !== State.New
      if (started || c.fsrs.state === State.Review) {
        items.push({ view: c, skill: 'prep', fsrs: c.fsrsPrep })
      }
    }
  }
  return items
}

export const itemKey = (i: StudyItem) => `${i.view.path}#${i.skill}`

/**
 * Очередь сессии: Learning/Relearning → Review (due сегодня) → New (лимит).
 * Review и New перемешаны interleaving-ом, learning — впереди по due.
 */
export function buildQueue(cards: CardView[], newBudget: number, now: Date = new Date()): StudyItem[] {
  const eod = endOfStudyDay(now)
  const items = expandItems(cards)

  const learning = items
    .filter(i => isLearning(i.fsrs.state) && i.fsrs.due.getTime() <= now.getTime() + LEARN_AHEAD_MS)
    .sort((a, b) => a.fsrs.due.getTime() - b.fsrs.due.getTime())

  const review = shuffle(items.filter(i => i.fsrs.state === State.Review && i.fsrs.due.getTime() < eod.getTime()))

  // выбор новых: сначала error/grammar (закрывают доказанные пробелы), потом math, потом словарь;
  // словарь идёт уровнями (Duolingo-путь): level ASC, внутри уровня — свежедобавленные последними
  // (added ASC, стабильный порядок). error/grammar/math/transition — порядок прежний: added DESC.
  const fresh = items
    .filter(i => i.fsrs.state === State.New)
    .sort((a, b) => {
      const ka = kindRank(a.view)
      const kb = kindRank(b.view)
      if (ka !== kb) return ka - kb
      if (isLevelled(a.view) && isLevelled(b.view)) {
        if (a.view.level !== b.view.level) return a.view.level - b.view.level
        const ad = a.view.added.localeCompare(b.view.added)
        if (ad !== 0) return ad
        return a.view.slug.localeCompare(b.view.slug)
      }
      const ad = b.view.added.localeCompare(a.view.added)
      if (ad !== 0) return ad
      return a.view.slug.localeCompare(b.view.slug)
    })
  const newItems = shuffle(fresh.slice(0, Math.max(0, newBudget)))

  // interleaving с разрядкой: новые распределяем среди review, но не ближе чем через
  // NEW_GAP других карточек; позицию 0 не занимаем — сессия начинается с повтора, если он есть.
  // Если повторов мало и слова всё равно встают рядом, очередь дополнительно разряжается
  // на лету (отработка только что введённого слова служит разделителем).
  const mixed: StudyItem[] = [...review]
  if (newItems.length) {
    const stride = Math.max(NEW_GAP + 1, Math.round((review.length + newItems.length) / newItems.length))
    newItems.forEach((it, i) => {
      const pos = Math.min(mixed.length, (review.length ? 1 : 0) + i * stride)
      mixed.splice(pos, 0, it)
    })
  }
  return [...learning, ...mixed]
}

/**
 * Возврат карточки в очередь после оценки: позиция пропорциональна времени до due
 * (~20 c на карточку), иначе 10-минутный learning-шаг схлопнулся бы в ~30 секунд
 * и слово «выучивалось» бы из рабочей памяти, минуя запланированный интервал.
 */
export function requeuePosition(queueLen: number, next: FsrsCard, now: Date): number {
  const waitMs = next.due.getTime() - now.getTime()
  return Math.min(queueLen, Math.max(3, Math.ceil(waitMs / 20000)))
}

export function shouldRequeue(next: FsrsCard, now: Date): boolean {
  return isLearning(next.state) && next.due.getTime() - now.getTime() < 30 * 60000
}

/**
 * Формат упражнения:
 * - prep-навык → всегда prep (выбор предлога);
 * - recall в New → intro (знакомство: слово+значения+пример, без викторины);
 * - recall в Learning/Relearning → reveal (retrieval уже возможен — слово показывали);
 * - recall в Review → чередование по reps: MC (формат Words in Context цифрового SAT,
 *   дистракторы из колоды) и ввод с клавиатуры (production + написание).
 */
export function pickFormat(item: StudyItem, deck: CardView[], introduced?: Set<string>, lapsed?: Set<string>, reintroAllowed = true): Format {
  if (item.skill === 'prep') return 'prep'
  // авторские варианты (error/grammar/math) — всегда MC, включая первый показ
  if (item.view.choices.length >= 2) return 'mc'
  // числовой ответ (math) — всегда ввод, включая первый показ
  if (item.view.answerNum) return 'type'
  const typable = !item.view.word.includes(' ')
  if (item.fsrs.state === State.New) {
    // знакомство один раз за сессию; после него первая отработка — reveal (первый настоящий FSRS-рейтинг)
    return introduced?.has(itemKey(item)) ? 'reveal' : 'intro'
  }
  // слово, которое не смогли вспомнить («Заново» в этой сессии — на ЛЮБОЙ стадии, не только Review;
  // либо пришедшее в Relearning из прошлой сессии) — один раз переznakomим окном-знакомством
  // (значение + пример), в UI подпись «Подзабылось» вместо «Новое слово». Но окно-переznakomство
  // тратит тот же урочный лимит, что и новые (для мозга «Подзабылось» — та же нагрузка знакомства):
  // сверх лимита провал отрабатывается обычным упражнением, без окна.
  const failed = lapsed?.has(itemKey(item)) || (item.fsrs.state === State.Relearning && !introduced?.has(itemKey(item)))
  if (failed && reintroAllowed) return 'intro'
  if (item.fsrs.state !== State.Review) {
    // выпускной шаг learning — объективный формат: самооценка склонна к «показалось знакомым»
    return item.fsrs.reps >= 1 && typable ? 'type' : 'reveal'
  }
  const wantMc = item.fsrs.reps % 2 === 0
  if (wantMc && mcDistractors(item.view, deck).length >= 3) return 'mc'
  return typable ? 'type' : (mcDistractors(item.view, deck).length >= 3 ? 'mc' : 'reveal')
}

/** Дистракторы для MC: авторские confusables тьютора приоритетнее случайной выборки той же части речи */
export function mcDistractors(card: CardView, deck: CardView[], n = 3): string[] {
  const authored = card.confusables.filter(c => c && c.toLowerCase() !== card.word.toLowerCase())
  if (authored.length >= n) return shuffle(authored).slice(0, n)
  const pool = deck.filter(c => !c.suspended && c.word !== card.word && !authored.includes(c.word))
  const samePos = pool.filter(c => c.pos === card.pos)
  const src = samePos.length >= n - authored.length ? samePos : pool
  return [...authored, ...shuffle(src.map(c => c.word)).slice(0, n - authored.length)]
}

const COMMON_PREPS = ['about', 'against', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'to', 'toward', 'with']

/** Варианты для prep-упражнения: правильный + 3 частотных предлога */
export function prepOptions(answer: string, n = 3): string[] {
  const distractors = shuffle(COMMON_PREPS.filter(p => p !== answer)).slice(0, n)
  return shuffle([answer, ...distractors])
}

/** Расстояние Левенштейна — «опечатка» это 1 правка при длине слова ≥ 5 */
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

export type TypeVerdict = 'correct' | 'typo' | 'wrong'

export function checkTyped(typed: string, word: string): TypeVerdict {
  const t = typed.trim().toLowerCase()
  const w = word.trim().toLowerCase()
  if (t === w) return 'correct'
  if (w.length >= 5 && levenshtein(t, w) <= 1) return 'typo'
  return 'wrong'
}

/** Парсинг числового ответа: "15", "-2.5", ".75", "3/4", запятая как точка */
export function parseNum(s: string): number | null {
  const t = s.trim().replace(',', '.')
  const frac = t.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/)
  if (frac) {
    const d = Number(frac[2])
    return d ? Number(frac[1]) / d : null
  }
  const n = Number(t)
  return Number.isFinite(n) && t !== '' ? n : null
}

/** Числовая проверка с относительным допуском (эквивалентные формы: 0.8 = 4/5) */
export function checkNumeric(typed: string, answer: string): TypeVerdict {
  const a = parseNum(answer)
  const t = parseNum(typed)
  if (a === null || t === null) {
    return typed.trim().toLowerCase() === answer.trim().toLowerCase() ? 'correct' : 'wrong'
  }
  return Math.abs(a - t) <= 1e-6 * Math.max(1, Math.abs(a)) ? 'correct' : 'wrong'
}

/**
 * Предлагаемая оценка по объективному результату (пользователь может переопределить).
 * Латентность учитывается: SAT — тест на скорость, верный-но-медленный ответ = Hard.
 * Опечатка предлагает Good: орфография на рецептивном экзамене не проверяется.
 */
export function suggestedGrade(format: Format, correct: boolean, typo: boolean, elapsedMs = 0, kind = 'vocab'): Grade | null {
  if (format === 'reveal' || format === 'intro') return null
  if (!correct && !typo) return Rating.Again
  const slowMs = kind === 'math' ? 90_000 : 25_000
  if (elapsedMs > slowMs) return Rating.Hard
  return Rating.Good
}

/** Прогноз нагрузки: сколько учебных единиц придёт на повтор в ближайшие N дней (просрочка → сегодня) */
export function loadForecast(cards: CardView[], days = 7, now: Date = new Date()): number[] {
  const out = new Array(days).fill(0)
  const today = dayKey(now)
  const dayKeys = Array.from({ length: days }, (_, k) => addDaysKey(today, k))
  for (const i of expandItems(cards)) {
    if (i.fsrs.state === State.New) continue
    let d = dayKey(i.fsrs.due)
    if (d < today) d = today
    const idx = dayKeys.indexOf(d)
    if (idx >= 0) out[idx]++
  }
  return out
}

/** Счётчики для главного экрана (в учебных единицах: карточка × навык) */
export function homeCounts(cards: CardView[], newBudget: number, now: Date = new Date()) {
  const eod = endOfStudyDay(now)
  const items = expandItems(cards)
  const learnDue = items.filter(i => isLearning(i.fsrs.state) && i.fsrs.due.getTime() <= now.getTime() + LEARN_AHEAD_MS).length
  const revDue = items.filter(i => i.fsrs.state === State.Review && i.fsrs.due.getTime() < eod.getTime()).length
  const newAvail = Math.min(items.filter(i => i.fsrs.state === State.New).length, Math.max(0, newBudget))
  const revTomorrow = items.filter(i => {
    const t = i.fsrs.due.getTime()
    return i.fsrs.state === State.Review && t >= eod.getTime() && t < eod.getTime() + 86400_000
  }).length + items.filter(i => isLearning(i.fsrs.state) && i.fsrs.due.getTime() > now.getTime() + LEARN_AHEAD_MS && i.fsrs.due.getTime() < eod.getTime() + 86400_000).length
  const active = cards.filter(c => !c.suspended)
  const byState = {
    new: active.filter(c => c.fsrs.state === State.New).length,
    learning: active.filter(c => isLearning(c.fsrs.state)).length,
    review: active.filter(c => c.fsrs.state === State.Review).length
  }
  return { learnDue, revDue, newAvail, revTomorrow, byState, total: active.length }
}
