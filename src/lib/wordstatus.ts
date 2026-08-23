import { State } from 'ts-fsrs'
import type { CardView } from './types'
import { isLevelled } from './scheduler'
import { isLeechCard, MATURE_STABILITY_DAYS } from './metrics'

/**
 * Единый источник правды о состоянии ОДНОГО слова.
 *
 * До 23.08.2026 этой функции не было вовсе — «введено» и «закрепилось» на главном экране
 * складывались двумя самостоятельными выражениями: одно прямо в разметке (`Home.tsx`),
 * другое внутри `maturity()` (`metrics.ts`). Совпадали они лишь потому, что оба читали одни
 * и те же поля `CardView` напрямую, и ничто не удерживало их вместе. Экран списка слов стал
 * бы третьим потребителем и третьей версией того же условия.
 *
 * Тот же приём здесь уже применён к пиявке и объяснён у `isLeechCard`: «одно определение на
 * отчёт, снимок метрик и экран — списки и счётчик обязаны сходиться». Этот модуль
 * распространяет правило на все стадии слова, а не только на пиявку.
 *
 * Модуль чистый: никакого React и DOM, только `CardView` на входе. Поэтому вся логика
 * проверяется в Node — как и `readclock.ts`.
 */

/** Стадия одного слова — то, что видно человеку на будущем экране списка. */
export type WordStage = 'leech' | 'learning' | 'review' | 'mature' | 'new' | 'suspended'

export interface WordStatus {
  stage: WordStage
  /** доля до зрелости, 0..1: 0 у new/suspended, иначе stability / MATURE_STABILITY_DAYS, не больше 1 */
  progress: number
  stability: number
  due: Date | null
  reps: number
  lapses: number
}

/**
 * Стадия слова. Порядок проверок важен и специально закомментирован по шагам:
 * каждое следующее условие видит только то, что не отсеяли предыдущие.
 */
export function wordStatus(v: CardView): WordStatus {
  const f = v.fsrs
  const stage = classify(v)
  return {
    stage,
    progress: stage === 'new' || stage === 'suspended' ? 0 : Math.min(1, f.stability / MATURE_STABILITY_DAYS),
    stability: f.stability,
    due: f.due ?? null,
    reps: f.reps,
    lapses: f.lapses
  }
}

function classify(v: CardView): WordStage {
  // 1. Отложенное слово не участвует ни в очереди, ни в счётчиках главной — этот
  //    признак сильнее всего остального, включая пиявку и зрелость.
  if (v.suspended) return 'suspended'
  // 2. Ещё не показывалось ни разу — стадии зрелости для него попросту нет.
  if (v.fsrs.state === State.New) return 'new'
  // 3. Пиявка перебивает Review/Learning: слово с восемью показами и стабильностью
  //    меньше двух дней формально «в работе», а по существу требует не повторения,
  //    а переделки карточки (см. isLeechCard/LEECH_REPS/LEECH_STABILITY_DAYS в metrics.ts).
  //    Пиявкой карточку делает и застрявший prep-навык — так считает isLeechCard, и здесь
  //    он зовётся целиком, а не переписывается по полям fsrs: иначе счётчик пиявок в
  //    отчёте и стадия слова на экране разошлись бы на словах с предлогами.
  //
  //    ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ЭТА СВОДКА РАСХОДИТСЯ С `maturity().matureCount`: слово со
  //    стабильностью выше порога, но с застрявшим prep-навыком, здесь «застряло», а там
  //    «зрелое». Расхождение намеренное — закреплённым слово, у которого провален навык
  //    предлога, называть нельзя, а экран списка заводится ровно затем, чтобы такое было
  //    видно. На 23.08.2026 оно ещё и чисто теоретическое: в живой колоде нет ни одной
  //    карточки с полем `prep`, то есть `fsrsPrep` везде пуст и числа совпадают до единицы.
  if (isLeechCard(v)) return 'leech'
  // 4. Зрелость определяется стабильностью, а не состоянием FSRS: Review с
  //    достаточной стабильностью — «закрепилось», это и есть вторая цель приложения.
  if (v.fsrs.stability >= MATURE_STABILITY_DAYS) return 'mature'
  // 5. Не пиявка, не зрелое, но уже в Review — «помню», обычный повтор по графику.
  if (v.fsrs.state === State.Review) return 'review'
  // 6. Всё остальное — Learning и Relearning: слово ещё знакомится/переучивается.
  return 'learning'
}

/** Порядок показа человеку: сверху то, что требует внимания, снизу — что не требует. */
export const STAGE_ORDER: readonly WordStage[] = ['leech', 'learning', 'review', 'mature', 'new', 'suspended']

/**
 * Подписи ровно такие, какие видит человек на экране. «Пиявка» — внутренний термин
 * (см. `isLeechCard` в metrics.ts), на экран он не идёт: пользователю нужно «застряло»,
 * а не жаргон отчёта.
 */
export const STAGE_LABEL: Record<WordStage, string> = {
  leech: 'застряло',
  learning: 'знакомлюсь',
  review: 'помню',
  mature: 'закрепилось',
  new: 'не введено',
  suspended: 'отложено'
}

/** Словарная карточка: только у неё осмыслен статус слова (см. isLevelled в scheduler.ts). */
export function isWordCard(v: CardView): boolean {
  return isLevelled(v)
}

export interface StageCount {
  stage: WordStage
  n: number
}

/**
 * Сводка по стадиям в порядке STAGE_ORDER, включая стадии с нулём слов.
 * Пустая стадия — тоже ответ: её пропуск сделал бы список статусов «прыгающим»
 * при переключении между колодами разного размера.
 */
export function stageCounts(cards: CardView[]): StageCount[] {
  const counts = new Map<WordStage, number>(STAGE_ORDER.map(s => [s, 0]))
  for (const v of cards) {
    if (!isWordCard(v)) continue
    const { stage } = wordStatus(v)
    counts.set(stage, (counts.get(stage) ?? 0) + 1)
  }
  return STAGE_ORDER.map(stage => ({ stage, n: counts.get(stage) ?? 0 }))
}

/**
 * Чистый отбор слов для будущего экрана списка: поиск по слову и по русскому значению,
 * фильтр по стадии, устойчивый порядок.
 *
 * Порядок результата — STAGE_ORDER → progress по возрастанию → алфавит по слову. Он не
 * зависит от порядка карточек во входном массиве: список статусов не должен «прыгать»
 * при пересинхронизации колоды, где порядок карточек не гарантирован.
 */
export function filterWords(cards: CardView[], query: string, stage: WordStage | null): CardView[] {
  const q = query.trim().toLowerCase()
  const stageOf = new Map<string, WordStage>()
  const progressOf = new Map<string, number>()
  const matched = cards.filter(v => {
    if (!isWordCard(v)) return false
    const status = wordStatus(v)
    if (stage !== null && status.stage !== stage) return false
    if (q && !v.word.toLowerCase().includes(q) && !v.meaning_ru.toLowerCase().includes(q)) return false
    stageOf.set(v.slug, status.stage)
    progressOf.set(v.slug, status.progress)
    return true
  })
  const rank = new Map(STAGE_ORDER.map((s, i) => [s, i]))
  return matched.sort((a, b) => {
    const ra = rank.get(stageOf.get(a.slug)!)!
    const rb = rank.get(stageOf.get(b.slug)!)!
    if (ra !== rb) return ra - rb
    const pa = progressOf.get(a.slug)!
    const pb = progressOf.get(b.slug)!
    if (pa !== pb) return pa - pb
    return a.word.localeCompare(b.word)
  })
}
