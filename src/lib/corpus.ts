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
 * Основа слова - грубая лемматизация по типовым окончаниям (`-s`, `-ed`, `-ing`, `-es`,
 * `-ies`), а не словарь: разбор берёт готовую токенизацию (`segmentText`) и готовый набор
 * кандидатов словоизменения (`lemmaCandidates`) из `reading.ts` - то же, чем текст сводит
 * «borrowed» к глоссарной форме «borrow». Модуль не пишет свой токенизатор и свой стеммер
 * с нуля, а выбирает из уже посчитанных кандидатов САМЫЙ КОРОТКИЙ (после кандидатов от
 * суффиксов длиннее корня не остаётся) и снимает конечную немую «e», которую суффиксные
 * правила лемматизации иногда оставляют (`emphasize` -> `emphasiz`, `emphasized` ->
 * `emphasiz` тем же путём) - без этого шага «emphasize» и «emphasized» расходились бы на
 * одну букву и считались разными словами.
 *
 * Признак - бинарный (`inCorpus`) для тиебрейкера ввода новых и счётный (`corpusHits`) для
 * отбора просроченного: слову, встречающемуся в вопросах восемнадцать раз, есть смысл
 * освежить раньше, чем слову, которого экзамен ни разу не спросит.
 */
import type { QuestionRec, ReadingRec } from './types'
import { segmentText, lemmaCandidates } from './reading'
import { normWord } from './journal'

/** Основа слова для корпусного индекса - см. комментарий модуля. */
export function corpusStem(word: string): string {
  const forms = lemmaCandidates(normWord(word))
  let stem = forms[0]
  for (const f of forms) if (f.length < stem.length) stem = f
  if (stem.length > 3 && stem.endsWith('e')) stem = stem.slice(0, -1)
  return stem
}

function countText(index: Map<string, number>, text: string): void {
  if (!text) return
  for (const seg of segmentText(text)) {
    if (seg.kind !== 'word') continue
    const stem = corpusStem(seg.text)
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
  return index.get(corpusStem(word)) ?? 0
}

/** Бинарный признак: слово (в любой форме) встречается в корпусе хотя бы раз. */
export function inCorpus(index: Map<string, number>, word: string): boolean {
  return corpusHits(index, word) > 0
}
