import { fsrs, generatorParameters, Rating, State, type Grade, type Card as FsrsCard, type FSRS } from 'ts-fsrs'
import type { CardView, Format, StudyItem } from './types'
import { endOfStudyDay } from './daytime'

export function makeScheduler(requestRetention: number): FSRS {
  return fsrs(generatorParameters({ request_retention: requestRetention }))
}

/** Экзамен и потолок интервалов: всё должно вернуться на повтор до SAT */
export const EXAM_DATE = new Date(2026, 11, 5)   // 05.12.2026, локально
export const DUE_CAP = new Date(2026, 10, 28)    // 28.11.2026

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

/** Learning-карточки показываем чуть раньше срока (Anki learn-ahead), чтобы шаг не терялся на конце сессии/дня */
export const LEARN_AHEAD_MS = 30 * 60000

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

  // выбор новых детерминированный (FIFO: recall раньше prep, затем по slug), случайна только подача
  const fresh = items
    .filter(i => i.fsrs.state === State.New)
    .sort((a, b) => (a.skill === b.skill ? a.view.slug.localeCompare(b.view.slug) : a.skill === 'recall' ? -1 : 1))
  const newItems = shuffle(fresh.slice(0, Math.max(0, newBudget)))

  // interleaving: новые распределяем равномерно среди review (не пачкой в конце),
  // но позицию 0 не занимаем — сессия начинается с повтора, если он есть
  const mixed: StudyItem[] = [...review]
  if (newItems.length) {
    const step = (mixed.length + newItems.length) / newItems.length
    newItems.forEach((it, i) => {
      const pos = review.length ? Math.max(1, Math.round((i + 0.7) * step)) : Math.round(i * step)
      mixed.splice(Math.min(mixed.length, pos), 0, it)
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
export function pickFormat(item: StudyItem, deck: CardView[]): Format {
  if (item.skill === 'prep') return 'prep'
  // авторские варианты (error/grammar-карточки) — всегда MC, включая первый показ
  if (item.view.choices.length >= 2) return 'mc'
  if (item.fsrs.state === State.New) return 'intro'
  if (item.fsrs.state !== State.Review) return 'reveal'
  const wantMc = item.fsrs.reps % 2 === 0
  if (wantMc && mcDistractors(item.view, deck).length >= 3) return 'mc'
  return 'type'
}

/** Дистракторы для MC: слова той же части речи (или любые, если своих мало) */
export function mcDistractors(card: CardView, deck: CardView[], n = 3): string[] {
  const pool = deck.filter(c => !c.suspended && c.word !== card.word)
  const samePos = pool.filter(c => c.pos === card.pos)
  const src = samePos.length >= n ? samePos : pool
  return shuffle(src.map(c => c.word)).slice(0, n)
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

/** Предлагаемая оценка по объективному результату (пользователь может переопределить) */
export function suggestedGrade(format: Format, correct: boolean, typo: boolean): Grade | null {
  if (format === 'reveal') return null
  if (correct) return Rating.Good
  if (typo) return Rating.Hard
  return Rating.Again
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
