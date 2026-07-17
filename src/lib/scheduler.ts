import { fsrs, generatorParameters, Rating, State, type Grade, type Card as FsrsCard, type FSRS } from 'ts-fsrs'
import type { CardView } from './types'
import { endOfStudyDay } from './daytime'

export function makeScheduler(requestRetention: number): FSRS {
  return fsrs(generatorParameters({ request_retention: requestRetention }))
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
 * Очередь сессии: Learning/Relearning (просроченные) → Review (due сегодня) → New (лимит).
 * Review и New перемешаны interleaving-ом (не блоками по source), learning — впереди по due.
 */
export function buildQueue(cards: CardView[], newBudget: number, now: Date = new Date()): CardView[] {
  const eod = endOfStudyDay(now)
  const active = cards.filter(c => !c.suspended)

  const learning = active
    .filter(c => isLearning(c.fsrs.state) && c.fsrs.due.getTime() <= now.getTime() + LEARN_AHEAD_MS)
    .sort((a, b) => a.fsrs.due.getTime() - b.fsrs.due.getTime())

  const review = shuffle(active.filter(c => c.fsrs.state === State.Review && c.fsrs.due.getTime() < eod.getTime()))

  // выбор новых детерминированный (FIFO по slug), случайна только подача
  const fresh = active
    .filter(c => c.fsrs.state === State.New)
    .sort((a, b) => a.slug.localeCompare(b.slug))
  const newCards = shuffle(fresh.slice(0, Math.max(0, newBudget)))

  // interleaving: новые распределяем равномерно среди review, не пачкой в конце
  const mixed: CardView[] = [...review]
  if (newCards.length) {
    const step = (mixed.length + newCards.length) / newCards.length
    newCards.forEach((c, i) => mixed.splice(Math.min(mixed.length, Math.round(i * step)), 0, c))
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

/** Счётчики для главного экрана */
export function homeCounts(cards: CardView[], newBudget: number, now: Date = new Date()) {
  const eod = endOfStudyDay(now)
  const active = cards.filter(c => !c.suspended)
  const learnDue = active.filter(c => isLearning(c.fsrs.state) && c.fsrs.due.getTime() <= now.getTime() + LEARN_AHEAD_MS).length
  const revDue = active.filter(c => c.fsrs.state === State.Review && c.fsrs.due.getTime() < eod.getTime()).length
  const newAvail = Math.min(active.filter(c => c.fsrs.state === State.New).length, Math.max(0, newBudget))
  const revTomorrow = active.filter(c => {
    const t = c.fsrs.due.getTime()
    return c.fsrs.state === State.Review && t >= eod.getTime() && t < eod.getTime() + 86400_000
  }).length + active.filter(c => isLearning(c.fsrs.state) && c.fsrs.due.getTime() > now.getTime() + LEARN_AHEAD_MS && c.fsrs.due.getTime() < eod.getTime() + 86400_000).length
  const byState = {
    new: active.filter(c => c.fsrs.state === State.New).length,
    learning: active.filter(c => isLearning(c.fsrs.state)).length,
    review: active.filter(c => c.fsrs.state === State.Review).length
  }
  return { learnDue, revDue, newAvail, revTomorrow, byState, total: active.length }
}
