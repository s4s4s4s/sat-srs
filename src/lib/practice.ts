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
 * Лёгкий график повтора вопроса практики (P5, WS4). У вопроса нет FSRS (см. заголовок файла),
 * но и «однажды решил, больше никогда не увидишь» неверно другим боком: 122 вопроса банка
 * College Board отвечены дважды, и повтор через месяц-другой всё ещё проверяет узнавание
 * формата, а не память об ответе. Поэтому график простой и не FSRS: два срока по последней
 * попытке, не по истории целиком - только что вспомнил хуже, чем вспоминал раньше.
 */
export const PRACTICE_RETRY_WRONG_DAYS = 2
export const PRACTICE_RETRY_RIGHT_DAYS = 8

/** Учебный день, с которого вопрос снова готов к повтору (по последней попытке). */
function retryDayOf(last: JournalLine): string {
  const days = last.correct === true ? PRACTICE_RETRY_RIGHT_DAYS : PRACTICE_RETRY_WRONG_DAYS
  return addDaysKey(last.day, days)
}

/**
 * Очередь вопросов на сессию практики.
 *
 * Порядок групп: 1) вопросы, которых в журнале не было ни разу (свежие); 2) отвеченные
 * вопросы, для которых срок повтора уже наступил, от самых просроченных; 3) отвеченные
 * вопросы, которым рано (график ещё не истёк) - хвостом, тоже по сроку.
 *
 * Прежняя версия отправляла верно решённый вопрос в группу 3 НАВСЕГДА, не зная времени -
 * это и есть баг из goal WS4. Теперь у верного и у неверного ответа есть срок годности
 * (`PRACTICE_RETRY_RIGHT_DAYS`/`PRACTICE_RETRY_WRONG_DAYS`), и по его истечении вопрос
 * возвращается в группу «к повтору», а не остаётся похороненным в хвосте.
 *
 * `moduleQueue` берёт из этой же очереди первые вопросы модуля, поэтому группа 3
 * (ещё не созревшие) не выбрасывается вовсе: в банке меньше `MODULE_QUESTIONS` вопросов,
 * и очередь обязана отдать все имеющиеся, даже недавно отвеченные.
 *
 * Функция чистая и детерминированная: все данные приходят аргументами, состояние она не читает;
 * `now` - точка отсчёта «сегодня» (учебный день, `dayKey`), по умолчанию текущий момент.
 */
export function pickPractice(
  views: QuestionView[],
  journal: JournalLine[],
  filter?: PracticeFilter,
  now: Date = new Date()
): QuestionView[] {
  const today = dayKey(now)
  const fresh: QuestionView[] = []
  const due: { v: QuestionView; retryDay: string }[] = []
  const notYet: { v: QuestionView; retryDay: string }[] = []

  for (const v of views) {
    if (v.broken || !matchesFilter(v, filter)) continue
    const attempts = attemptsFor(journal, v.qid)
    if (!attempts.length) { fresh.push(v); continue }
    const retryDay = retryDayOf(attempts[attempts.length - 1])
    ;(retryDay <= today ? due : notYet).push({ v, retryDay })
  }

  const byRetryDay = (a: { retryDay: string; v: QuestionView }, b: { retryDay: string; v: QuestionView }) =>
    a.retryDay.localeCompare(b.retryDay) || a.v.qid.localeCompare(b.v.qid)
  due.sort(byRetryDay)
  notYet.sort(byRetryDay)

  return [...fresh, ...due.map(d => d.v), ...notYet.map(d => d.v)]
}

/** Сколько отвеченных вопросов созрели для повтора именно сегодня (для подписи блока практики). */
export function practiceDue(views: QuestionView[], journal: JournalLine[], now: Date = new Date()): number {
  const today = dayKey(now)
  let due = 0
  for (const v of views) {
    if (v.broken) continue
    const attempts = attemptsFor(journal, v.qid)
    if (!attempts.length) continue // свежий вопрос - не «повтор», а первое знакомство
    if (retryDayOf(attempts[attempts.length - 1]) <= today) due++
  }
  return due
}

/**
 * Режим модуля (D5): 27 вопросов подряд под общим бюджетом времени, как модуль RW
 * настоящего цифрового SAT. `PACE_SEC` - мягкий темп на один вопрос (не жёсткий лимит,
 * экран его не блокирует), согласован с бюджетом модуля: `MODULE_SECONDS / MODULE_QUESTIONS`
 * округляется ровно до него.
 */
export const MODULE_QUESTIONS = 27
export const MODULE_SECONDS = 32 * 60 // 1920 с = 32 мин
export const PACE_SEC = 71 // MODULE_SECONDS / MODULE_QUESTIONS ≈ 71.1

/** Первые `MODULE_QUESTIONS` из общей очереди практики, очередь не переставляется по-своему. */
export function moduleQueue(views: QuestionView[], journal: JournalLine[], now: Date = new Date()): QuestionView[] {
  return pickPractice(views, journal, undefined, now).slice(0, MODULE_QUESTIONS)
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

/** Разрез по темпу (мягкий таймер PACE_SEC): сколько измеренных попыток и сколько из них за бюджетом. */
export interface PacePracticeStats {
  measured: number  // попытки с известным sec
  slow: number      // из них - те, что превысили PACE_SEC (поле slow в строке журнала)
}

/** Разрезы практики сверх `practiceStats`: по сложности, за неделю, по времени ответа. */
export interface PracticeBreakdown {
  byDifficulty: Record<string, PracticeGroupStats>
  week: WeekPracticeStats
  avgSec: number | null    // среднее время на попытку за то же окно, где sec известен; null - таких нет
  pace: PacePracticeStats
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
  let slowN = 0

  for (const l of journal) {
    if (l.type !== 'practice' || !l.qid || !validQids.has(l.qid)) continue
    if (!l.day || l.day < from || l.day > today) continue
    weekAttempts++
    if (l.correct === true) weekCorrect++
    if (typeof l.sec === 'number') { secSum += l.sec; secN++; if (l.slow) slowN++ }
  }

  return {
    byDifficulty,
    week: { attempts: weekAttempts, accuracy: weekAttempts ? Math.round((weekCorrect / weekAttempts) * 100) : null },
    avgSec: secN ? secSum / secN : null,
    pace: { measured: secN, slow: slowN }
  }
}
