import type { CardView, JournalLine } from './types'
import { SECTIONS, homeCounts, sectionOf, type Section } from './scheduler'
import { isGraded } from './journal'
import { addDaysKey } from './daytime'

/**
 * Долг раздела в оценках дня. Окно, за которое считается фактическая доля
 * оценок раздела (учебных дней, включая сегодняшний).
 */
const DEBT_WINDOW_DAYS = 7

/**
 * Доля вопросов Reading & Writing цифрового SAT по разделу (для приоритета дня).
 *
 * Источник - структура цифрового SAT: модуль RW даёт 54 вопроса на секцию (два
 * модуля по 27), поделённых между четырьмя доменами College Board. `grammar`
 * (домен SEC, Standard English Conventions) - 13/54. `logic` (домены II/CS/EOI:
 * Information and Ideas, Craft and Structure, Expression of Ideas - рассуждение
 * по тексту, см. `sectionOf` в scheduler.ts) - 26/54. `rw` (словарь, Words in
 * Context внутри Craft and Structure) - 12/54. Сумма трёх - 51/54: оставшиеся
 * вопросы Craft and Structure (структура текста, не лексика и не SEC) не входят
 * ни в один из трёх разделов колоды и здесь не считаются. `math` - 0: у
 * математики отдельная секция экзамена, в долг RW она не входит и своего
 * ежедневного бюджета не теряет (см. `newPerDay` в norms.ts).
 */
export const RW_WEIGHTS: Record<Section, number> = {
  grammar: 13 / 54,
  logic: 26 / 54,
  rw: 12 / 54,
  math: 0
}

/** Есть ли в разделе что делать прямо сейчас - новое слово или просроченный повтор.
 *  Бюджет намеренно не ограничивает счёт (Infinity): здесь важно, есть ли работа
 *  вообще, а не сколько её разрешает сегодняшняя норма ввода.
 *  Журнал передаётся обязательно: у раздела «Логика» работа считается по нему, а не по
 *  fsrs-срокам (logic.ts), и без журнала долг раздела состоял бы из уже разобранных вопросов. */
function hasWork(cards: CardView[], journal: JournalLine[]): boolean {
  const c = homeCounts(cards, Infinity, new Date(), journal)
  return c.learnDue > 0 || c.revDue > 0 || c.newAvail > 0
}

/**
 * Долг раздела: доля веса минус фактическая доля оценок раздела за окно.
 *
 * Раздел без новых карточек и без просроченных повторов долга не несёт - сколько
 * бы веса за ним ни числилось, урок по нему всё равно не соберётся, и приоритет
 * без работы за ним превращается в кнопку, которая ничего не даёт (та же ловушка,
 * что у `newBudgetTotal` без ограничения по наличию новых).
 */
export function sectionDebt(
  journal: JournalLine[],
  cards: CardView[],
  day: string,
  window = DEBT_WINDOW_DAYS
): Record<Section, number> {
  const bySlug = new Map(cards.map(c => [c.slug, c] as const))
  const days = new Set<string>()
  for (let i = 0; i < window; i++) days.add(addDaysKey(day, -i))

  const gradedBySection: Record<Section, number> = { rw: 0, logic: 0, grammar: 0, math: 0 }
  let gradedTotal = 0
  for (const l of journal) {
    if (!isGraded(l) || !l.slug || !days.has(l.day)) continue
    const card = bySlug.get(l.slug)
    if (!card) continue
    gradedBySection[sectionOf(card)]++
    gradedTotal++
  }

  const bySection: Record<Section, CardView[]> = { rw: [], logic: [], grammar: [], math: [] }
  for (const c of cards) bySection[sectionOf(c)].push(c)

  const debt = {} as Record<Section, number>
  for (const s of SECTIONS) {
    const actualShare = gradedTotal > 0 ? gradedBySection[s] / gradedTotal : 0
    const raw = Math.max(0, RW_WEIGHTS[s] - actualShare)
    debt[s] = hasWork(bySection[s], journal) ? raw : 0
  }
  return debt
}

/**
 * Раздел с наибольшим долгом. Порядок перебора - `SECTIONS`, поэтому при равных
 * долгах (в том числе когда все долги нулевые - заниматься сегодня нечем нигде)
 * выигрывает первый по этому порядку раздел, а не случайный: функция детерминирована.
 */
export function nextSection(
  journal: JournalLine[],
  cards: CardView[],
  day: string,
  window = DEBT_WINDOW_DAYS
): Section {
  const debt = sectionDebt(journal, cards, day, window)
  let best: Section = SECTIONS[0]
  for (const s of SECTIONS) if (debt[s] > debt[best]) best = s
  return best
}

/** Порядок разделов дня - по убыванию долга, тем же детерминированным перебором,
 *  что и `nextSection`; вторичный ключ - порядок `SECTIONS`, чтобы равные долги
 *  не переставляли блоки на каждый ререндер. */
export function sectionOrder(
  journal: JournalLine[],
  cards: CardView[],
  day: string,
  window = DEBT_WINDOW_DAYS
): Section[] {
  const debt = sectionDebt(journal, cards, day, window)
  return [...SECTIONS].sort((a, b) => debt[b] - debt[a])
}

/** Название раздела для главной кнопки «Сегодня: …» - те же слова, что у блока раздела. */
export const SECTION_TITLE: Record<Section, string> = {
  rw: 'Слова',
  logic: 'Логика',
  grammar: 'Грамматика',
  math: 'Математика'
}

/**
 * Причина приоритета - называет предмет, а не долю долга (проценты ничего не
 * говорят о том, чем заняться, а тема - говорит). Кнопка «Сегодня» показывает
 * ученику ПОЧЕМУ выбран именно этот раздел, а не абстрактное число.
 */
export const SECTION_REASON: Record<Section, string> = {
  grammar: 'грамматика: правила пунктуации',
  logic: 'логика: рассуждение по тексту',
  rw: 'словарь: новые слова и повторение',
  math: 'математика: тренировка по темам'
}
