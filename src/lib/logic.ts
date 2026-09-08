/**
 * Логика = карточки раздела `logic` (`sectionOf` в scheduler.ts: `kind: error` и домены
 * II/CS/EOI). Это вопрос к тексту с четырьмя авторскими вариантами, а не слово.
 *
 * ОДНОРАЗОВАЯ МОДЕЛЬ ВМЕСТО FSRS. До 09.09.2026 такие карточки шли общим потоком
 * планировщика: learning-шаги, интервалы, повторы (у `log-ii-most-trebuet-cifry` дошло до
 * восьми). Интервальное повторение проверяет память о ФАКТЕ, а вопрос к отрывку памятью не
 * берётся: второй показ того же вопроса проверяет, помнит ли ученик, что верным был вариант
 * B, а не умеет ли он читать текст. Словами ученика: «логику нельзя заучить». Поэтому у
 * раздела своя механика, ровно та же, что у настоящих вопросов SAT (`practice.ts`,
 * `pickPractice`): вопрос показывается, пока не решён, и не больше `LOGIC_MAX_SHOWS` раз.
 *
 * Модуль чистый: всё состояние приходит аргументами (карточки и журнал), ни React, ни базы -
 * поэтому проверяется в Node (`test/logic.test.ts`), как `practice.ts` и `readclock.ts`.
 *
 * FSRS-поля карточки логики после этой правки не двигаются вовсе: `expandItems` (scheduler.ts)
 * такие карточки не разворачивает, `rateItem` для них не вызывается. Значит, `fsrs.state`
 * навсегда остаётся тем, что было в файле, и НИ ОДИН счётчик не имеет права судить о логике
 * по нему - состояние карточки логики живёт только в журнале (`logicStatus`).
 */
import { Rating } from 'ts-fsrs'
import type { CardView, JournalLine, StudyItem } from './types'
import { addDaysKey, dayKey, isoLocal } from './daytime'
import { byLineTime, journalElapsedMs, newId } from './journal'
import { PRACTICE_RETRY_WRONG_DAYS } from './practice'
import { isLogicCard, newIntroAllowed } from './scheduler'

/**
 * Сколько раз вопрос логики вообще показывается, пока не решён.
 *
 * Три - это «два возврата после первой ошибки». Дальше показывать нечего: если после двух
 * разборов ход рассуждения не взят, вопрос закрывается и уходит тьютору как пробел, а не
 * крутится в уроке. Верный ответ закрывает вопрос раньше, на любом показе (`solved`).
 */
export const LOGIC_MAX_SHOWS = 3

/**
 * Состояние вопроса логики - выводится из журнала, а не из карточки:
 * - `fresh` - попыток не было;
 * - `retry` - были только неверные, и лимит показов ещё не исчерпан;
 * - `solved` - была верная попытка, вопрос закрыт навсегда;
 * - `closed` - все попытки неверные и их уже `LOGIC_MAX_SHOWS`.
 */
export type LogicStatus = 'fresh' | 'retry' | 'solved' | 'closed'

/**
 * Попытки по вопросу логики в хронологии (`ts`, при равенстве `ms` - тайбрейк D1).
 *
 * Попыткой считается review-строка с этим слагом и объективным результатом (`correct` -
 * булево). Показ без результата (окно знакомства, `format: intro`) попыткой не является:
 * он ничего не проверяет. Порядок задаёт общий `byLineTime` из journal.ts - тот же, что у
 * `attemptsFor` в practice.ts; две копии сортировки журнала разъехались бы на первом же
 * изменении правила тайбрейка.
 */
export function logicAttempts(journal: JournalLine[], slug: string): JournalLine[] {
  return journal
    .filter(l => l.type === 'review' && l.slug === slug && typeof l.correct === 'boolean')
    .slice()
    .sort(byLineTime)
}

/** Состояние вопроса логики по журналу (см. `LogicStatus`). */
export function logicStatus(slug: string, journal: JournalLine[]): LogicStatus {
  const attempts = logicAttempts(journal, slug)
  if (!attempts.length) return 'fresh'
  if (attempts.some(a => a.correct === true)) return 'solved'
  return attempts.length >= LOGIC_MAX_SHOWS ? 'closed' : 'retry'
}

/**
 * Учебный день, с которого проваленный вопрос снова готов к показу: день последней попытки
 * плюс `PRACTICE_RETRY_WRONG_DAYS`. Константа взята у практики намеренно - это одна и та же
 * величина («через сколько дней имеет смысл вернуть непонятое»), и разводить её на две
 * значило бы завести второе место, где её правят.
 */
export function logicRetryDay(lastAttempt: JournalLine): string {
  return addDaysKey(lastAttempt.day, PRACTICE_RETRY_WRONG_DAYS)
}

interface RetryCard { view: CardView; retryDay: string }

interface LogicSlice {
  fresh: CardView[]      // ни одной попытки, в порядке ввода (added, затем slug)
  retry: RetryCard[]     // провалены и ещё не закрыты, самые просроченные первыми
  solved: CardView[]     // решены верно хотя бы раз
  closed: CardView[]     // исчерпали LOGIC_MAX_SHOWS и остались неверными
}

/** Разбор набора карточек по состояниям. Единственное место, где считается состав раздела:
 *  очередь, счётчики главной и `homeCounts` обязаны видеть одну и ту же картину. Срок
 *  возврата остаётся при карточке (`RetryCard.retryDay`), а сравнение с сегодняшним днём -
 *  забота вызывающего: у очереди и у счётчиков «завтра» разные вопросы к одному срезу. */
function sliceLogic(cards: CardView[], journal: JournalLine[]): LogicSlice {
  const fresh: CardView[] = []
  const retry: RetryCard[] = []
  const solved: CardView[] = []
  const closed: CardView[] = []

  for (const v of cards) {
    if (v.suspended || !isLogicCard(v)) continue
    const attempts = logicAttempts(journal, v.slug)
    if (!attempts.length) { fresh.push(v); continue }
    if (attempts.some(a => a.correct === true)) { solved.push(v); continue }
    if (attempts.length >= LOGIC_MAX_SHOWS) { closed.push(v); continue }
    retry.push({ view: v, retryDay: logicRetryDay(attempts[attempts.length - 1]) })
  }

  fresh.sort((a, b) => a.added.localeCompare(b.added) || a.slug.localeCompare(b.slug))
  retry.sort((a, b) => a.retryDay.localeCompare(b.retryDay) || a.view.slug.localeCompare(b.view.slug))

  return { fresh, retry, solved, closed }
}

/**
 * Тот же срез раздела, но числами - для счётчиков главной и `homeCounts` (scheduler.ts).
 *
 * Отдельная функция, а не поля `LogicCounts`: счётчики раздела и счётчики планировщика
 * отвечают на разные вопросы (первым нужны «осталось / разобрано / ошибок», второму -
 * раскладка по срокам: долг на сегодня, завтрашний план, доступное новое), а считаться
 * обязаны из одного среза, иначе плашка раздела и очередь урока разъедутся.
 */
export interface LogicSliceCounts {
  fresh: number         // ни разу не показанные вопросы (без учёта дневного бюджета)
  retryDue: number      // возвраты, срок которых уже наступил - долг раздела на сегодня
  retryLater: number    // возвраты, которым ещё рано
  retryTomorrow: number // из них те, что созреют завтра
  solved: number
  closed: number
}

export function logicSliceCounts(cards: CardView[], journal: JournalLine[], now: Date = new Date()): LogicSliceCounts {
  const s = sliceLogic(cards, journal)
  const today = dayKey(now)
  const завтра = addDaysKey(today, 1)
  return {
    fresh: s.fresh.length,
    retryDue: s.retry.filter(r => r.retryDay <= today).length,
    retryLater: s.retry.filter(r => r.retryDay > today).length,
    retryTomorrow: s.retry.filter(r => r.retryDay === завтра).length,
    solved: s.solved.length,
    closed: s.closed.length
  }
}

/**
 * Очередь раздела «Логика».
 *
 * Порядок: сначала созревшие возвраты (самые просроченные первыми), затем свежие вопросы -
 * не больше дневного бюджета, детерминированно по `added`, при равенстве по слагу. Решённые,
 * закрытые и не созревшие возвраты не попадают в очередь НИКОГДА: в этом и есть смысл
 * одноразовой модели.
 *
 * Стоп ввода нового (`newIntroAllowed`, правило A8) закрывает именно свежие вопросы, а не
 * возвраты: незакрытый разбор - это долг, а не знакомство, и стоп ввода его не отменяет.
 *
 * Функция чистая и детерминированная: `now` - точка отсчёта учебного дня (`dayKey`).
 */
export function pickLogic(
  cards: CardView[],
  journal: JournalLine[],
  newBudget: number,
  now: Date = new Date()
): CardView[] {
  const s = sliceLogic(cards, journal)
  const today = dayKey(now)
  const retryDue = s.retry.filter(r => r.retryDay <= today).map(r => r.view)
  const fresh = newIntroAllowed(now, 'logic') ? s.fresh.slice(0, Math.max(0, newBudget)) : []
  return [...retryDue, ...fresh]
}

/** Очередь логики в учебных единицах планировщика. Навык всегда `recall` (второго у разбора
 *  нет), формат показа даёт `pickTask`: у карточки есть авторские `choices`, и `baseFormat`
 *  отвечает на них `mc` на любом показе - отдельного поля формата в `StudyItem` нет. */
export function buildLogicQueue(
  cards: CardView[],
  journal: JournalLine[],
  newBudget: number,
  now: Date = new Date()
): StudyItem[] {
  return pickLogic(cards, journal, newBudget, now).map(view => ({ view, skill: 'recall', fsrs: view.fsrs }))
}

/** Счётчики раздела для главной: «осталось / разобрано / ошибок» и кнопка «Разбирать · avail». */
export interface LogicCounts {
  left: number    // не закрытые вопросы: свежие плюс все возвраты (в том числе не созревшие)
  solved: number  // разобрано верно
  wrong: number   // исчерпали показы и остались неверными - это пробел, а не работа на завтра
  avail: number   // сколько урок выдаст прямо сейчас (длина pickLogic)
}

export function logicCounts(
  cards: CardView[],
  journal: JournalLine[],
  newBudget: number,
  now: Date = new Date()
): LogicCounts {
  const c = logicSliceCounts(cards, journal, now)
  const freshAvail = newIntroAllowed(now, 'logic') ? Math.min(c.fresh, Math.max(0, newBudget)) : 0
  return {
    left: c.fresh + c.retryDue + c.retryLater,
    solved: c.solved,
    wrong: c.closed,
    avail: c.retryDue + freshAvail
  }
}

/** Сколько свежих вопросов логики показано ПЕРВЫЙ раз в этот учебный день - то, что списывается
 *  с дневного бюджета раздела (`newBudgetFor` в scheduler.ts).
 *
 *  Считать это через `newIntroducedOn` нельзя: тот опознаёт ввод по `prev_state: 0` (состояние
 *  FSRS до оценки), а у логики FSRS не пишется вовсе и поля `prev_state` в строке нет. Признак
 *  ввода здесь - «эта попытка была первой по вопросу», и он читается из самого журнала. */
export function logicFreshShownOn(journal: JournalLine[], day: string, slugs?: ReadonlySet<string>): number {
  const first = new Map<string, JournalLine>()
  for (const l of journal) {
    if (l.type !== 'review' || !l.slug || typeof l.correct !== 'boolean') continue
    if (slugs && !slugs.has(l.slug)) continue
    const prev = first.get(l.slug)
    if (!prev || byLineTime(l, prev) < 0) first.set(l.slug, l)
  }
  let n = 0
  for (const l of first.values()) if (l.day === day) n++
  return n
}

/** Свежих (ни разу не показанных) вопросов в наборе - слагаемое `newBudgetTotal`: у логики
 *  «новое» считается по журналу, а не по `fsrs.state`, который здесь навсегда остаётся New. */
export function logicFreshCount(cards: CardView[], journal: JournalLine[]): number {
  return sliceLogic(cards, journal).fresh.length
}

/**
 * Строка журнала для ответа на вопрос логики - замена `rateItem` (store.ts) для этого раздела:
 * FSRS-блок карточки не трогается, наружу уходит только факт ответа.
 *
 * `rating` пишется, хотя никакого планировщика за ним не стоит: по нему день считает работу
 * (`isGraded` в journal.ts - основа `reviewsByDay`, минут дня, серии, долга раздела в
 * dayplan.ts и цели захода). Строка без `rating` означала бы, что разобранный вопрос не
 * засчитан ученику вовсе. `prev_state`/`new_state`/`due`/`stability` не пишутся намеренно:
 * состояния FSRS у логики больше нет, и пустые поля честнее выдуманных - на них стоят
 * `retentionByFormat` и `isMatureShow`, и они обязаны такую строку пропустить.
 */
export function logicReviewLine(
  view: CardView,
  correct: boolean,
  elapsedMs: number,
  answerMs?: number,
  now: Date = new Date()
): JournalLine {
  return {
    id: newId(),
    v: 1,
    type: 'review',
    ts: isoLocal(now),
    ms: now.getMilliseconds(),
    day: dayKey(now),
    slug: view.slug,
    skill: 'recall',
    format: 'mc',
    correct,
    rating: correct ? Rating.Good : Rating.Again,
    ...(view.kind !== 'vocab' ? { kind: view.kind } : {}),
    ...(view.domain ? { domain: view.domain } : {}),
    elapsed_ms: journalElapsedMs(elapsedMs, view.kind),
    ...(answerMs !== undefined ? { answer_ms: journalElapsedMs(answerMs, view.kind) } : {})
  }
}
