/**
 * Ротация значений слова (T5).
 *
 * Словарная карточка учит одно главное значение (meaning_en/meaning_ru, контексты
 * contexts/contextsRu), а остальные значения лежат в other_senses (Sense, types.ts).
 * На экзамене слово может спросить в любом значении, поэтому у значений в other_senses
 * появляются свои примеры-предложения (contexts/contextsRu внутри элемента), и урок обязан
 * ротировать значения между показами, а не долбить одно главное. Правило C17 колоды.
 *
 * Правило ротации: слот, на котором ученик провалился в прошлый раз, спрашивается снова
 * (провал - сигнал незнания именно этого значения, повторить его немедленно полезнее, чем
 * идти дальше по кругу); слот, где ученик провалился, но затем этот слот пропал из карточки
 * (тьютор убрал контексты), откатывается на главное значение; иначе спрашивается первый
 * непройденный слот по порядку (главное значение первым); когда пройдены все слоты хотя бы
 * по разу успешно, ротация идёт по кругу дальше от последнего показанного. Знакомство
 * (intro), навык предлога (prep) и опора cue = 'word' (значение уже на экране) всегда
 * спрашивают главное значение - там ротировать нечего или незачем.
 */

import type { CardView, Format, JournalLine } from './types'
import type { Cue } from './scheduler'

/** Одно значение слова в ротации показа: idx 0 - главное, i+1 - other_senses[i]. */
export interface SenseSlot {
  idx: number
  pos: string
  en: string
  ru: string
  contexts: string[]
  contextsRu: string[]
}

/**
 * Все значения карточки как слоты, независимо от того, есть ли у них контексты. Источник
 * правды для двух разных нужд: senseSlots (только спрашиваемые - фильтрует по контекстам) и
 * senseDisplay (показ "Ещё значения" после ответа - показывает вообще все, контексты неважны).
 */
function allSenses(view: CardView): SenseSlot[] {
  const out: SenseSlot[] = [{
    idx: 0, pos: view.pos, en: view.meaning_en, ru: view.meaning_ru,
    contexts: view.contexts, contextsRu: view.contextsRu
  }]
  view.other_senses.forEach((s, i) => {
    out.push({ idx: i + 1, pos: s.pos, en: s.en, ru: s.ru, contexts: s.contexts, contextsRu: s.contextsRu })
  })
  return out
}

/**
 * Слоты, которые можно спросить: главное значение всегда, остальные - только те, у которых
 * тьютор завёл хотя бы один контекст (без контекста значение нечем проверить отдельно от
 * главного, и спрашивать его как самостоятельный слот нельзя).
 */
export function senseSlots(view: CardView): SenseSlot[] {
  return allSenses(view).filter(s => s.idx === 0 || s.contexts.length > 0)
}

/** Слот по индексу; вне диапазона или без контекстов (не входит в senseSlots) - главное значение. */
export function senseSlot(view: CardView, idx: number): SenseSlot {
  const slots = senseSlots(view)
  return slots.find(s => s.idx === idx) ?? slots[0]
}

/**
 * Строка журнала, которую можно спросить в конкретном значении: review словаря, навык recall
 * (или отсутствует - старые строки), формат не intro и не prep - те всегда спрашивают главное
 * значение, ротации не касаются. Единый предикат для senseHistory (ротация показа) и
 * senseShare (metrics.ts, доля ответов по неглавным значениям) - определение одно, не дублируется.
 */
export function isSenseReviewLine(line: JournalLine): boolean {
  if (line.type !== 'review') return false
  if (line.skill && line.skill !== 'recall') return false
  if (line.format === 'intro' || line.format === 'prep') return false
  return true
}

/**
 * История показов слова по строкам журнала: только те, что проходят isSenseReviewLine, и
 * только этого слова. Порядок - как в журнале (журнал хронологический).
 */
export function senseHistory(journal: JournalLine[], slug: string): { sense: number; failed: boolean }[] {
  const out: { sense: number; failed: boolean }[] = []
  for (const line of journal) {
    if (!isSenseReviewLine(line)) continue
    if (line.slug !== slug) continue
    out.push({ sense: line.sense ?? 0, failed: line.rating === 1 || line.gave_up === true })
  }
  return out
}

/**
 * Ядро ротации: по списку слотов, которые можно спросить сейчас, и истории показов выбирает
 * индекс значения для следующего показа. Чистая функция без журнала и карточки - проверяется
 * таблицей случаев отдельно от pickSense.
 */
export function chooseSense(slotIdxs: number[], history: { sense: number; failed: boolean }[]): number {
  if (slotIdxs.length <= 1) return 0

  const last = history[history.length - 1]
  if (last && last.failed) {
    return slotIdxs.includes(last.sense) ? last.sense : 0
  }

  const passed = new Set(history.filter(h => !h.failed).map(h => h.sense))
  for (const idx of slotIdxs) {
    if (!passed.has(idx)) return idx
  }

  // все слоты пройдены хотя бы раз успешно - следующий по кругу после последнего показанного
  const lastSense = last ? last.sense : slotIdxs[0]
  const pos = slotIdxs.indexOf(lastSense)
  return slotIdxs[(pos === -1 ? 0 : pos + 1) % slotIdxs.length]
}

/**
 * Значение для следующего показа карточки. Знакомство, навык предлога и cue = 'word'
 * (само слово уже на экране) всегда спрашивают главное значение.
 */
export function pickSense(view: CardView, journal: JournalLine[], format: Format, cue: Cue): number {
  if (format === 'intro' || format === 'prep' || cue === 'word') return 0
  const slots = senseSlots(view)
  return chooseSense(slots.map(s => s.idx), senseHistory(journal, view.slug))
}

/**
 * Ключ ротации контекстов (nextCtxIndex/pickContext в scheduler.ts): при idx 0 совпадает со
 * старым ключом (путём карточки), чтобы прежние счётчики ротации не сбросились; у остальных
 * значений - свой ключ, чтобы показы разных значений не делили один и тот же счётчик контекста.
 */
export function ctxKey(path: string, idx: number): string {
  return idx === 0 ? path : `${path}#${idx}`
}

/**
 * Показанное значение и остальные, в порядке индексов. `asked` берётся из спрашиваемых слотов
 * (senseSlots - у него обязан быть контекст, кроме idx 0). `rest` - ВСЕ прочие значения
 * карточки, включая те, у которых тьютор ещё не завёл контекст: после ответа показывается
 * список "Ещё значения" целиком, а не только те, что годятся для ротации показа - ученику
 * полезно видеть все значения слова, даже те, что пока нечем спросить отдельно.
 */
export function senseDisplay(view: CardView, idx: number): { asked: SenseSlot; rest: SenseSlot[] } {
  const slots = senseSlots(view)
  const asked = slots.find(s => s.idx === idx) ?? slots[0]
  const rest = allSenses(view).filter(s => s.idx !== asked.idx)
  return { asked, rest }
}
