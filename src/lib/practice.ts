/**
 * Практика = настоящие вопросы SAT (`Учёба/Вопросы`) с четырьмя вариантами и разбором.
 *
 * Отдельная сущность от карточек по той же причине, что и текст для чтения (см. `ReadingRec`
 * в types.ts, `reading.ts`): у вопроса нет и не будет FSRS-графика — повторный показ уже
 * решённого вопроса проверял бы память об ОТВЕТЕ, а не сам навык. Поэтому очередь практики
 * не участвует ни в планировщике карточек, ни в норме ввода, и живёт своими чистыми функциями,
 * без React и без базы — ими сможет пользоваться и экран, и статистика.
 *
 * Разбор тела файла обязан быть УСТОЙЧИВЫМ: файлы пишет инструмент пк-контура, но формат —
 * обычный текст, и любое отклонение (неизвестный заголовок, отсутствующий раздел вариантов,
 * не четыре варианта, буквы не по порядку, `answer` на несуществующую букву) обязано ставить
 * `broken`, а не ронять приложение — тем же приёмом, что и `parseMd` для frontmatter.
 */
import type { JournalLine, QuestionChoice, QuestionRec, QuestionView } from './types'
import { addDaysKey, dayKey } from './daytime'

const KNOWN_SECTIONS = new Set(['Вопрос', 'Варианты', 'Разбор'])
const LETTERS = ['A', 'B', 'C', 'D'] as const

interface ParsedBody {
  stem: string
  choices: QuestionChoice[]
  rationale: string
  broken: boolean
}

/**
 * Разбор тела вопроса на условие / варианты / разбор.
 *
 * Заголовки — ровно `## Вопрос`, `## Варианты`, `## Разбор` (третий может отсутствовать целиком).
 * Любой неизвестный заголовок, отсутствие раздела «## Варианты», число вариантов не равное
 * четырём или буквы не по порядку A/B/C/D — всё это даёт `broken`, но не бросает исключение:
 * вызывающий получает частично разобранные данные и решает сам, показывать вопрос или нет.
 */
export function parseQuestionBody(body: string): ParsedBody {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const sections: { name: string; text: string }[] = []
  let current: { name: string; buf: string[] } | null = null
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/)
    if (m) {
      if (current) sections.push({ name: current.name, text: current.buf.join('\n') })
      current = { name: m[1].trim(), buf: [] }
    } else if (current) {
      current.buf.push(line)
    }
    // строки до первого заголовка (обычно пустые) в разбор не идут
  }
  if (current) sections.push({ name: current.name, text: current.buf.join('\n') })

  let broken = sections.some(s => !KNOWN_SECTIONS.has(s.name))

  const stemSection = sections.find(s => s.name === 'Вопрос')
  const choicesSection = sections.find(s => s.name === 'Варианты')
  const rationaleSection = sections.find(s => s.name === 'Разбор')

  if (!stemSection) broken = true

  const choices: QuestionChoice[] = []
  if (!choicesSection) {
    broken = true
  } else {
    // вариант — одна строка, варианты разделены пустой строкой
    const blocks = choicesSection.text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
    if (blocks.length !== 4) broken = true
    blocks.forEach((block, i) => {
      const m = block.match(/^([A-D])\.\s*([\s\S]*)$/)
      if (!m) { broken = true; return }
      const letter = m[1] as QuestionChoice['letter']
      // буквы не по порядку — это возможно только когда вариантов и так не четыре штуки,
      // ЛИБО когда порядок в самом файле сбит; оба случая — брак разбора
      if (blocks.length !== 4 || letter !== LETTERS[i]) broken = true
      choices.push({ letter, text: m[2].trim() })
    })
  }

  return {
    stem: (stemSection?.text ?? '').trim(),
    choices,
    rationale: (rationaleSection?.text ?? '').trim(),
    broken
  }
}

/** Запись вопроса → типизированный вид. Лишние поля frontmatter остаются в `QuestionRec.fm`. */
export function questionView(rec: QuestionRec): QuestionView {
  const fm = rec.fm ?? {}
  const { stem, choices, rationale, broken: bodyBroken } = parseQuestionBody(rec.body)

  const rawAnswer = typeof fm.answer === 'string' ? fm.answer.trim().toUpperCase() : ''
  const answerKnown = !rawAnswer || choices.some(c => c.letter === rawAnswer)
  const answer = answerKnown && rawAnswer ? (rawAnswer as QuestionView['answer']) : ''

  return {
    path: rec.path,
    qid: String(fm.qid ?? ''),
    assessment: String(fm.assessment ?? ''),
    test: String(fm.test ?? ''),
    domain: String(fm.domain ?? ''),
    skill: String(fm.skill ?? ''),
    difficulty: String(fm.difficulty ?? ''),
    stem,
    choices,
    answer,
    rationale,
    added: String(fm.added ?? ''),
    broken: !!rec.broken || bodyBroken || !answerKnown
  }
}

/** Узкий фильтр очереди практики: пустое поле — «любой». */
export interface PracticeFilter {
  skill?: string
  difficulty?: string
}

function matchesFilter(v: QuestionView, filter?: PracticeFilter): boolean {
  if (!filter) return true
  if (filter.skill && v.skill !== filter.skill) return false
  if (filter.difficulty && v.difficulty !== filter.difficulty) return false
  return true
}

/** Строки практики (type: 'practice') по вопросу, отсортированные по времени ответа. */
function attemptsFor(journal: JournalLine[], qid: string): JournalLine[] {
  return journal
    .filter(l => l.type === 'practice' && l.qid === qid)
    .slice()
    .sort((a, b) => a.ts.localeCompare(b.ts) || (a.ms ?? 0) - (b.ms ?? 0))
}

/**
 * Очередь вопросов на сессию практики.
 *
 * Порядок групп: 1) вопросы, которых в журнале не было ни разу; 2) вопросы, на которых был
 * хотя бы один неверный ответ и НИ ОДНОГО верного — от самых давних (по времени первой попытки);
 * 3) уже верно решённые — только когда групп 1–2 не хватает на весь список.
 *
 * Функция чистая и детерминированная: все данные приходят аргументами, состояние она не читает.
 */
export function pickPractice(views: QuestionView[], journal: JournalLine[], filter?: PracticeFilter): QuestionView[] {
  const fresh: QuestionView[] = []
  const wrong: { v: QuestionView; first: string }[] = []
  const solved: QuestionView[] = []

  for (const v of views) {
    if (v.broken || !matchesFilter(v, filter)) continue
    const attempts = attemptsFor(journal, v.qid)
    if (!attempts.length) { fresh.push(v); continue }
    if (attempts.some(a => a.correct === true)) { solved.push(v); continue }
    wrong.push({ v, first: attempts[0].ts })
  }

  wrong.sort((a, b) => a.first.localeCompare(b.first))
  return [...fresh, ...wrong.map(w => w.v), ...solved]
}

/** Сводка по одному разрезу (весь набор или один навык). */
export interface PracticeGroupStats {
  total: number
  solved: number   // отвечено хотя бы раз
  correct: number  // из отвеченных — хотя бы один верный ответ
}

export interface PracticeStats extends PracticeGroupStats {
  bySkill: Record<string, PracticeGroupStats>
}

const emptyGroup = (): PracticeGroupStats => ({ total: 0, solved: 0, correct: 0 })

/**
 * Разрез практики по производному ключу вопроса (навык, сложность — что угодно из QuestionView).
 * Общая механика для `bySkill` и `byDifficulty`: битые вопросы отбрасываются, «отвечено» — была
 * хотя бы одна попытка, «верно» — среди попыток была хотя бы одна верная (семантика вопроса,
 * а не попытки: пересдал со второго раза — вопрос засчитан верным).
 */
function groupByKey(views: QuestionView[], journal: JournalLine[], keyOf: (v: QuestionView) => string): Record<string, PracticeGroupStats> {
  const groups: Record<string, PracticeGroupStats> = {}
  for (const v of views) {
    if (v.broken) continue
    const group = groups[keyOf(v)] ?? (groups[keyOf(v)] = emptyGroup())
    group.total++
    const attempts = attemptsFor(journal, v.qid)
    if (attempts.length) {
      group.solved++
      if (attempts.some(a => a.correct === true)) group.correct++
    }
  }
  return groups
}

/** Сводка практики: всего вопросов, отвечено, из них верно — целиком и по каждому навыку. */
export function practiceStats(views: QuestionView[], journal: JournalLine[]): PracticeStats {
  const bySkill = groupByKey(views, journal, v => v.skill)
  const total = Object.values(bySkill).reduce((acc, g) => ({
    total: acc.total + g.total,
    solved: acc.solved + g.solved,
    correct: acc.correct + g.correct
  }), emptyGroup())

  return { ...total, bySkill }
}

/** Сколько попыток пришло за последние 7 учебных дней (включая сегодня) и какая среди них точность. */
export interface WeekPracticeStats {
  attempts: number         // строк practice за окно, ПОПЫТКИ, не вопросы
  accuracy: number | null  // доля верных ПОПЫТОК среди них, 0..100; null — попыток не было
}

/** Разрезы практики сверх `practiceStats`: по сложности, за неделю, по времени ответа. */
export interface PracticeBreakdown {
  byDifficulty: Record<string, PracticeGroupStats>
  week: WeekPracticeStats
  avgSec: number | null    // среднее время на попытку по строкам, где sec известен; null — таких нет
}

/**
 * Разрез по сложности + недельная динамика + скорость ответа.
 *
 * Недельная `accuracy` — ДРУГАЯ величина, чем `correct` в `PracticeGroupStats`: там единица счёта —
 * вопрос (решён = была хоть одна верная попытка когда-либо), здесь единица счёта — попытка
 * (строка журнала). Два неверных ответа на один и тот же вопрос за неделю — это 0 из 2 попыток,
 * а не 0 из 1 вопроса; смешивать их в одно число значило бы тихо занижать или завышать точность
 * в зависимости от того, сколько раз человек пересдавал один вопрос.
 *
 * Битые вопросы не попадают ни в один разрез — то же правило, что в `practiceStats`: попытки,
 * привязанные к qid вопроса, отсутствующего среди небитых `views` (вопрос стал битым уже после
 * того, как на него отвечали), в разрезы за неделю и по времени не идут.
 */
export function practiceBreakdown(views: QuestionView[], journal: JournalLine[], today: string = dayKey()): PracticeBreakdown {
  const byDifficulty = groupByKey(views, journal, v => v.difficulty)
  const validQids = new Set(views.filter(v => !v.broken).map(v => v.qid))
  const from = addDaysKey(today, -6)

  let weekAttempts = 0
  let weekCorrect = 0
  let secSum = 0
  let secN = 0

  for (const l of journal) {
    if (l.type !== 'practice' || !l.qid || !validQids.has(l.qid)) continue
    if (typeof l.sec === 'number') { secSum += l.sec; secN++ }
    if (!l.day || l.day < from || l.day > today) continue
    weekAttempts++
    if (l.correct === true) weekCorrect++
  }

  return {
    byDifficulty,
    week: { attempts: weekAttempts, accuracy: weekAttempts ? Math.round((weekCorrect / weekAttempts) * 100) : null },
    avgSec: secN ? secSum / secN : null
  }
}
