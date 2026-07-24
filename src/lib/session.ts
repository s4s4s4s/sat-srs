import { State } from 'ts-fsrs'
import type { CardView, Format, StudyItem } from './types'
import { pickFormat, itemKey, MIN_SHOW_GAP_MS, NEW_GAP } from './scheduler'

/**
 * Выбор следующего экрана сессии — чистая логика, без React и IndexedDB (её же гоняет
 * симуляция в test/). Свод правил A2/A3/A4 (см. `Учёба/Карточки/_правила-srs.md`) сведён
 * в один расчёт: очередь не показывает два экрана одного слова встык и не выдаёт два
 * знакомства подряд без упражнения между ними.
 */
export interface OrderCtx {
  deck: CardView[]
  introduced: Set<string>          // itemKey слов, которым уже показано знакомство в этой сессии
  lapsed: Set<string>              // itemKey «подзабытых» в этой сессии (следующий показ — окно)
  reintroAllowed: boolean          // остался ли лимит окон-знакомств за урок
  shownTimes: Map<string, number>  // itemKey → мс последнего показа (A2)
  now: number
  lastPath: string | null          // path карточки, показанной ПРЕДЫДУЩИМ экраном (A3)
  lastWasIntro: boolean            // предыдущий экран был окном-знакомством (A4)
  sinceIntro: number               // отработок с последнего знакомства (A4 — разнос по времени)
}

/** Формат, которым единица отрисуется прямо сейчас — тот же расчёт, что и в UI (makeTask). */
export function screenFormat(item: StudyItem, ctx: OrderCtx): Format {
  return pickFormat(item, ctx.deck, ctx.introduced, ctx.lapsed, ctx.reintroAllowed)
}

/** True, если показ единицы будет окном-знакомством: новое слово (intro) или «Подзабылось». */
export function isIntroScreen(item: StudyItem, ctx: OrderCtx): boolean {
  return screenFormat(item, ctx) === 'intro'
}

/**
 * Индекс следующей единицы в `list`, либо −1 — «показать без нарушения инварианта нечего»
 * (карточка ждёт: вызывающий добирает сегодняшние недоработанные или завершает урок,
 * см. A3 «если вставить нечего — карточка ждёт, а не показывается повторно»).
 * Порядок очереди сохраняется — берётся ПЕРВАЯ допустимая единица. Единица `it` допустима:
 *   A2 — с её прошлого показа прошло ≥ MIN_SHOW_GAP_MS (или не показывалась);
 *   A3 — это другое слово, чем показанное предыдущим экраном (не два экрана слова встык);
 *   A4 — если это окно-знакомство: предыдущий экран НЕ был знакомством (между двумя
 *        знакомствами обязано стоять упражнение) И с прошлого знакомства прошло ≥ NEW_GAP отработок.
 * Новое слово сверх лимита окон-знакомств за урок не выбирается вовсе — оно ждёт следующего
 * урока/дня (иначе снятие его с головы «вслепую» могло бы поставить два экрана слова встык, A3).
 */
export function pickNextIndex(list: StudyItem[], ctx: OrderCtx): number {
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    const last = ctx.shownTimes.get(itemKey(it)) ?? 0
    if (last && ctx.now - last < MIN_SHOW_GAP_MS) continue                // A2
    if (ctx.lastPath && it.view.path === ctx.lastPath) continue          // A3
    if (isIntroScreen(it, ctx)) {                                         // A4
      const isFreshNew = it.fsrs.state === State.New && !ctx.introduced.has(itemKey(it))
      if (isFreshNew && !ctx.reintroAllowed) continue // новое сверх лимита — ждёт следующего урока
      if (ctx.lastWasIntro) continue
      if (ctx.sinceIntro < NEW_GAP) continue
    }
    return i
  }
  return -1
}
