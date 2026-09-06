/**
 * Корпус экзаменационного языка: сколько раз основа слова встречается в реальных вопросах
 * College Board и текстах для чтения.
 *
 * Задача: очередь новых слов и срез просроченного при переполнении не должны быть слепы
 * к тому, что слово ученик УВИДИТ на практике или в тексте. `freshItems` шёл по level ASC
 * без этого признака - слово четвёртой ступени, встречающееся в банке вопросов трижды, не
 * доедет до очереди, пока не введены все слова уровней 1-3, а срез overdue при переполнении
 * дневного потолка сортировался только по `due` и не отличал слово с восемнадцатью
 * вхождениями в вопросы от слова, которого в банке нет вовсе.
 *
 * Основа слова - общий консервативный стеммер `lightStem` (`stem.ts`, J2, 06.09.2026): разбор
 * берёт готовую токенизацию (`segmentText`) и сводит каждое слово к основе тем же стеммером,
 * которым `deckHasWord` (`journal.ts`) сравнивает форму отметки со словами колоды. До правки
 * здесь жил свой стеммер (`corpusStem`, через `lemmaCandidates` из `reading.ts`) с другими
 * правилами, чем у `journal.ts` - два независимых определения «одного и того же слова» в одной
 * кодовой базе, которые не обязаны были сходиться и не сходились.
 *
 * Признак - бинарный (`inCorpus`) для тиебрейкера ввода новых и счётный (`corpusHits`) для
 * отбора просроченного: слову, встречающемуся в вопросах восемнадцать раз, есть смысл
 * освежить раньше, чем слову, которого экзамен ни разу не спросит.
 */
import type { QuestionRec, ReadingRec } from './types'
import { segmentText } from './reading'
import { normWord } from './journal'
import { lightStem } from './stem'

function countText(index: Map<string, number>, text: string): void {
  if (!text) return
  for (const seg of segmentText(text)) {
    if (seg.kind !== 'word') continue
    const stem = lightStem(normWord(seg.text))
    if (!stem) continue
    index.set(stem, (index.get(stem) ?? 0) + 1)
  }
}

/**
 * Индекс основ по всему корпусу экзаменационного языка: вопросы практики и тексты для
 * чтения. Битые записи (`broken`) не исключаются - слово встретилось в языке экзамена
 * независимо от того, разобралось ли приложение остальное тело файла.
 */
export function buildCorpusIndex(questions: QuestionRec[], readings: ReadingRec[]): Map<string, number> {
  const index = new Map<string, number>()
  for (const q of questions) countText(index, q.body)
  for (const r of readings) countText(index, r.body)
  return index
}

/** Сколько раз основа слова встретилась в корпусе. */
export function corpusHits(index: Map<string, number>, word: string): number {
  return index.get(lightStem(normWord(word))) ?? 0
}

/** Бинарный признак: слово (в любой форме) встречается в корпусе хотя бы раз. */
export function inCorpus(index: Map<string, number>, word: string): boolean {
  return corpusHits(index, word) > 0
}
