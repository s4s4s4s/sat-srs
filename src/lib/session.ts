import { State } from 'ts-fsrs'
import type { CardView, Format, StudyItem } from './types'
import { pickFormat, itemKey, MIN_SHOW_GAP_MS, NEW_GAP } from './scheduler'

/**
 * Выбор следующего экрана сессии — чистая логика, без React и IndexedDB (её же гоняет
 * симуляция в test/). Свод правил A2/A3/A4/A4-bis/A6 (см. `Учёба/Карточки/_правила-srs.md`)
 * сведён в один расчёт: очередь не показывает два экрана одного слова встык, не выдаёт
 * знакомство, которое урок не сможет довести до отработки, и различает «сейчас нельзя»
 * (истечёт таймер A2) от «нельзя вообще» (нарушение структуры).
 */
export interface OrderCtx {
  deck: CardView[]
  introduced: Set<string>          // itemKey слов, которым уже показано знакомство в этой сессии
  lapsed: Set<string>              // itemKey «подзабытых» в этой сессии (следующий показ — окно)
  reintroAllowed: boolean          // остался ли лимит окон-знакомств за урок (== introsLeft > 0)
  introsLeft: number               // сколько окон-знакомств урок ещё может выдать
  shownTimes: Map<string, number>  // itemKey → мс последнего показа (A2)
  now: number
  lastPath: string | null          // path карточки, показанной ПРЕДЫДУЩИМ экраном (A3)
  lastWasIntro: boolean            // предыдущий экран был окном-знакомством (A4)
  sinceIntro: number               // отработок с последнего знакомства (A4 — разнос по времени)
  batchIntros: number              // знакомств подряд без оценённой отработки между ними (A4-bis)
  hasFiller: boolean               // урок может добрать заполнитель (ранний повтор) — считается разделителем (A6)
}

/**
 * A4-bis: сколько знакомств подряд допустимо, когда разбавлять их отработками нечем.
 * A3 требует между `intro` и первой отработкой слова показ ДРУГОЙ карточки, а A4 в исходном
 * виде запрещает взять этой карточкой второе знакомство — на пуле из одних новых два правила
 * неразрешимы, и урок вырождался в «одно знакомство и конец» (25.07: одно и то же слово
 * показывалось знакомством четыре урока подряд). Батч даёт легальное чередование:
 * знакомство₁ → знакомство₂ → отработка₁ → отработка₂ … Смысл A4 сохранён — пока каждое
 * слово батча не получило оценку, новых знакомств не будет.
 */
export const INTRO_BATCH_MAX = 3

/**
 * C4: пустой или пробельный ответ — не ошибка ввода, а честное «не помню». «Проверить» с таким
 * полем идёт по тому же пути, что и кнопка «не помню» (показ ответа + `Again`, без сравнения с
 * правильным словом). Вынесено чистой функцией, чтобы правило проверялось тестом без React.
 */
export function isGiveUp(value: string): boolean {
  return !value.trim()
}

/** Формат, которым единица отрисуется прямо сейчас — тот же расчёт, что и в UI (makeTask). */
export function screenFormat(item: StudyItem, ctx: OrderCtx): Format {
  return pickFormat(item, ctx.deck, ctx.introduced, ctx.lapsed, ctx.reintroAllowed)
}

/** True, если показ единицы будет окном-знакомством: новое слово (intro) или «Подзабылось». */
export function isIntroScreen(item: StudyItem, ctx: OrderCtx): boolean {
  return screenFormat(item, ctx) === 'intro'
}

/** Знакомство нового слова (а не окно «Подзабылось» уже знакомого). */
function isFreshNew(item: StudyItem, ctx: OrderCtx): boolean {
  return item.fsrs.state === State.New && !ctx.introduced.has(itemKey(item))
}

/** Единицу нельзя показать в этом уроке ВООБЩЕ: новое сверх лимита окон-знакомств. */
function overIntroLimit(item: StudyItem, ctx: OrderCtx): boolean {
  return isFreshNew(item, ctx) && ctx.introsLeft <= 0
}

/**
 * A6: есть ли чем разделить знакомство и первую отработку слова.
 * Разделитель — показ ДРУГОГО слова, который урок реально сможет выдать: обычное упражнение,
 * знакомство в пределах батча (A4-bis) или заполнитель-ранний повтор. Если разделителя нет,
 * знакомство не выдаётся вовсе: показанное и брошенное знакомство помечает слово введённым,
 * не научив ему, и следующий урок повторяет его один в один.
 */
export function hasSeparator(list: StudyItem[], i: number, ctx: OrderCtx): boolean {
  const self = list[i].view.path
  const batchRoom = ctx.batchIntros + 1 < INTRO_BATCH_MAX
  for (let j = 0; j < list.length; j++) {
    if (j === i) continue
    const other = list[j]
    if (other.view.path === self) continue
    if (isFreshNew(other, ctx)) {
      // новое слово в разделители годится только если лимит окон-знакомств выдержит ДВА:
      // наше знакомство и его. Иначе после нашего оно станет непоказуемым, и отрабатывать
      // введённое слово будет нечем — ровно эта дыра и оставляла знакомство брошенным
      if (ctx.introsLeft < 2 || !batchRoom) continue
      return true
    }
    // окно «Подзабылось»: пока лимит держит два окна, нужно место в батче; при исчерпанном
    // лимите оно превратится в обычное упражнение и годится в разделители само по себе
    if (isIntroScreen(other, ctx) && ctx.introsLeft >= 2 && !batchRoom) continue
    return true
  }
  return ctx.hasFiller
}

type Block = 'ok' | 'time' | 'struct'

/**
 * Допустима ли единица прямо сейчас. `time` — мешает только 60-секундный разрыв A2
 * (пройдёт само), `struct` — нарушение, которое ожиданием не лечится.
 * relaxA4 = проход батча знакомств (A4-bis), когда строгим порядком показать нечего.
 */
function evaluate(list: StudyItem[], i: number, ctx: OrderCtx, relaxA4: boolean): Block {
  const it = list[i]
  if (ctx.lastPath && it.view.path === ctx.lastPath) return 'struct'   // A3
  if (isIntroScreen(it, ctx)) {
    if (overIntroLimit(it, ctx)) return 'struct'                       // новое сверх лимита — ждёт следующего урока
    if (!hasSeparator(list, i, ctx)) return 'struct'                   // A6
    if (relaxA4) {
      if (ctx.batchIntros >= INTRO_BATCH_MAX) return 'struct'          // A4-bis: батч исчерпан
    } else {
      if (ctx.lastWasIntro) return 'struct'                            // A4
      if (ctx.sinceIntro < NEW_GAP) return 'struct'                    // A4
    }
  }
  const last = ctx.shownTimes.get(itemKey(it)) ?? 0
  if (last && ctx.now - last < MIN_SHOW_GAP_MS) return 'time'          // A2
  return 'ok'
}

export interface NextPick {
  /** индекс следующей единицы в `list`; −1 = сейчас показывать нечего */
  idx: number
  /**
   * При idx < 0: сколько миллисекунд осталось до момента, когда ближайшая годная единица
   * пройдёт разрыв A2. 0 = ждать бесполезно, ограничение структурное (урок исчерпан).
   * Именно эта разница и была потеряна: «сейчас нельзя» трактовалось как «нечего добирать»,
   * и урок завершался после одного знакомства.
   */
  waitMs: number
}

/**
 * Следующий экран урока. Порядок очереди сохраняется — берётся ПЕРВАЯ допустимая единица.
 * Сначала строгий проход (A2 + A3 + A4 + A6), и только если он пуст — проход батча знакомств
 * (A4-bis), где допускается знакомство сразу после знакомства. A2, A3 и A6 не смягчаются никогда.
 */
export function pickNext(list: StudyItem[], ctx: OrderCtx): NextPick {
  let wait = Infinity
  for (const relaxA4 of [false, true]) {
    for (let i = 0; i < list.length; i++) {
      const b = evaluate(list, i, ctx, relaxA4)
      if (b === 'ok') return { idx: i, waitMs: 0 }
      if (b === 'time') {
        const last = ctx.shownTimes.get(itemKey(list[i])) ?? 0
        wait = Math.min(wait, MIN_SHOW_GAP_MS - (ctx.now - last))
      }
    }
  }
  return { idx: -1, waitMs: Number.isFinite(wait) ? Math.max(0, wait) : 0 }
}

/**
 * Индекс следующей единицы, либо −1 — «показать без нарушения инварианта нечего».
 * Обёртка над pickNext для вызовов, которым не нужна пауза (совместимость и тесты).
 */
export function pickNextIndex(list: StudyItem[], ctx: OrderCtx): number {
  return pickNext(list, ctx).idx
}
