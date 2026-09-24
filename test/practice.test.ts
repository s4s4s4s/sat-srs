/**
 * Тесты слоя данных ПРАКТИКИ: разбор файла вопроса (`Учёба/Вопросы`), выбор очереди на сессию
 * и сводка результатов, плюс обновление схемы локальной базы со 2 на 3 (появление хранилища
 * `questions`).
 *
 * Практика — та же логика раздельных сущностей, что у чтения (см. test/reading.test.ts,
 * ReadingRec/ReadingView в types.ts): у вопроса нет FSRS, повторный показ уже решённого вопроса
 * проверял бы память об ответе, а не навык. Поэтому разбор устойчив к браку файла (его пишет
 * инструмент пк-контура, а не человек) — неизвестный заголовок, отсутствующий раздел, число
 * вариантов не равное четырём, буквы не по порядку и ответ на несуществующую букву ставят
 * `broken`, а не роняют приложение.
 *
 * Обновление схемы БД проверяется НЕ структурно (в отличие от db.ts/DB_VERSION в reading.test.ts),
 * а исполнением: `fake-indexeddb` — по-настоящему совместимая с IndexedDB реализация для Node,
 * используемая ради этого теста (в package.json её раньше не было; обоснование — единственный
 * способ прогнать реальный upgrade() из db.ts, а не поверить структурной проверке исходника).
 * Старая база создаётся вручную на версии 2 с настоящими данными (карточка, строка журнала,
 * текст), затем открывается штатным db.ts (версия 3) — и старые данные обязаны пережить это
 * открытие, а новое хранилище `questions` — появиться пустым и рабочим.
 *
 * Каталог `Учёба/Вопросы` на 24.08.2026 в колоде ещё может не существовать (его наполняет
 * параллельный агент) — живых вопросов тест не ждёт и фикстуры собирает сам из текста задачи.
 *
 * Запуск: `npm run test:practice` (esbuild бандлит файл и node его исполняет).
 */
import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { parseMd } from '../src/lib/yamlfm'
import {
  parseQuestionBody, questionView, pickPractice, practiceStats, practiceBreakdown,
  practiceDue, moduleQueue, MODULE_QUESTIONS, MODULE_SECONDS, PACE_SEC, practiceSummaryLabel,
  practiceSectionOf, practiceVerdict, paceSecOf, MODULE_BY_SECTION
} from '../src/lib/practice'
import { getAllCards, getAllJournal, getAllReadings, getAllQuestions, applyQuestionsPull, kvGet } from '../src/lib/db'
import type { JournalLine, QuestionRec, QuestionView } from '../src/lib/types'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

// ---- фабрики ---------------------------------------------------------------

function qrec(raw: string, over: Partial<QuestionRec> = {}): QuestionRec {
  const { fm, body, broken } = parseMd(raw)
  return { path: 'Учёба/Вопросы/rhetorical-synthesis-medium-afec1a70.md', sha: 'sha-1', fm, body, broken, ...over }
}

/** Вид вопроса для проверок pickPractice/practiceStats: разбор тела здесь не важен. */
function view(qid: string, over: Partial<QuestionView> = {}): QuestionView {
  return {
    path: `Учёба/Вопросы/${qid}.md`,
    qid,
    assessment: 'SAT',
    test: 'Reading and Writing',
    domain: 'Expression of Ideas',
    skill: 'Rhetorical Synthesis',
    difficulty: 'Medium',
    section: 'rw',
    kind: 'mcq',
    html: false,
    stem: 'Stem.',
    choices: [
      { letter: 'A', text: 'a' }, { letter: 'B', text: 'b' },
      { letter: 'C', text: 'c' }, { letter: 'D', text: 'd' }
    ],
    answer: 'A',
    answers: [],
    rationale: 'Rationale.',
    added: '2026-08-24',
    broken: false,
    ...over
  }
}

let idSeq = 0
function practiceLine(o: Partial<JournalLine> & { qid: string }): JournalLine {
  idSeq++
  const ts = o.ts ?? '2026-08-24T10:00:00+04:00'
  // day по умолчанию берётся из ts (первые 10 символов ISO), а не из отдельной константы:
  // в реальном журнале day и ts всегда пишутся из одного `now` (см. logPractice в store.ts),
  // и фикстура с расходящимися day/ts маскировала бы ошибки в графике повтора (P5)
  return {
    id: `p-${idSeq}`,
    v: 1,
    type: 'practice',
    ts,
    ms: 0,
    day: ts.slice(0, 10),
    skill: 'Rhetorical Synthesis',
    difficulty: 'Medium',
    chose: 'A',
    correct: true,
    ...o
  }
}

// ---- разбор целого файла ----------------------------------------------------

const GOOD_MD = `---
type: question
qid: afec1a70
assessment: SAT
test: Reading and Writing
domain: Expression of Ideas
skill: Rhetorical Synthesis
difficulty: Medium
answer: A
added: '2026-08-24'
---

## Вопрос

While researching a topic, a student has taken the following notes:

- As engineered structures, many bird nests are uniquely flexible yet cohesive.
- A research team led by Yashraj Bhosale wanted to better understand the mechanics behind these structural properties.

The student wants to present the primary aim of the research study. Which choice most effectively uses relevant information from the notes to accomplish this goal?

## Варианты

A. Bhosale’s team wanted to better understand the mechanics behind bird nests’ uniquely flexible yet cohesive structural properties.

B. The researchers used laboratory models that simulated the arrangement of flexible sticks.

C. After analyzing the points where sticks touched, the researchers found that the structures became stiffer.

D. As analyzed by Bhosale’s team, bird nests are uniquely flexible yet cohesive engineered structures.

## Разбор

Choice A is the best answer. It uses relevant information from the notes to state the primary aim of the research study.
`

function goodFileChecks(): void {
  const v = questionView(qrec(GOOD_MD))
  assert(!v.broken, 'целый файл не битый')
  assert(v.qid === 'afec1a70' && v.assessment === 'SAT' && v.test === 'Reading and Writing', 'поля-идентификаторы из frontmatter')
  assert(v.domain === 'Expression of Ideas' && v.skill === 'Rhetorical Synthesis' && v.difficulty === 'Medium',
    'домен, навык и сложность из frontmatter')
  assert(v.added === '2026-08-24', 'дата добавления как строка (CORE_SCHEMA)')
  assert(v.stem.includes('- As engineered structures'), 'список внутри условия сохранён строками "- "')
  assert(v.stem.trim().endsWith('accomplish this goal?'), 'условие включает вопрос целиком, до раздела вариантов')
  assert(v.choices.length === 4, `ровно четыре варианта, получено ${v.choices.length}`)
  assert(v.choices.map(c => c.letter).join() === 'A,B,C,D', 'буквы вариантов по порядку A–D')
  assert(v.choices[0].text.includes('Bhosale’s team wanted'), 'текст варианта A разобран целиком, включая апостроф')
  assert(v.choices[3].text.startsWith('As analyzed by Bhosale’s team'), 'текст варианта D (с апострофом) разобран')
  assert(v.answer === 'A', 'правильный ответ из frontmatter')
  assert(v.rationale.startsWith('Choice A is the best answer.'), 'разбор — тело раздела «## Разбор»')
  group('файл вопроса: все поля, список в условии и апострофы в вариантах разобраны целиком')
}

function noRationaleChecks(): void {
  const noRationale = GOOD_MD
    .replace(/\nanswer: A/, '')
    .replace(/## Разбор[\s\S]*$/, '')
  const v = questionView(qrec(noRationale))
  assert(!v.broken, 'отсутствие раздела «## Разбор» не битый вопрос')
  assert(v.rationale === '', 'без раздела разбора rationale пуст')
  assert(v.answer === '', 'без ответа во frontmatter answer пуст')
  assert(v.choices.length === 4, 'варианты разбираются независимо от наличия разбора')
  group('файл без раздела «## Разбор»: rationale пуст, вопрос не считается битым')
}

function brokenChecks(): void {
  // три варианта вместо четырёх
  const threeChoices = GOOD_MD.replace(/\nD\. As analyzed by Bhosale’s team[^\n]*\n/, '\n')
  assert(questionView(qrec(threeChoices)).broken, 'три варианта вместо четырёх — broken')

  // буквы не по порядку: переставлены блоки B и C местами (сохранены их собственные буквы)
  const shuffled = GOOD_MD.replace(
    'B. The researchers used laboratory models that simulated the arrangement of flexible sticks.\n\nC. After analyzing the points where sticks touched, the researchers found that the structures became stiffer.',
    'C. After analyzing the points where sticks touched, the researchers found that the structures became stiffer.\n\nB. The researchers used laboratory models that simulated the arrangement of flexible sticks.'
  )
  assert(questionView(qrec(shuffled)).broken, 'буквы вариантов не по порядку — broken')

  // раздела «## Варианты» нет вовсе
  const noChoicesSection = GOOD_MD.replace(/## Варианты[\s\S]*?## Разбор/, '## Разбор')
  const noChoices = questionView(qrec(noChoicesSection))
  assert(noChoices.broken, 'вопрос без раздела «## Варианты» — broken')
  assert(noChoices.choices.length === 0, 'без раздела вариантов список вариантов пуст, а не выдуман')

  // answer указывает на несуществующую букву
  const badAnswer = GOOD_MD.replace('answer: A', 'answer: E')
  const bv = questionView(qrec(badAnswer))
  assert(bv.broken, 'answer на несуществующую букву — broken')
  assert(bv.answer === '', 'битый answer не протекает в вид как будто он верный')

  // неизвестный заголовок раздела
  const badHeading = GOOD_MD.replace('## Разбор', '## Пояснение')
  assert(questionView(qrec(badHeading)).broken, 'неизвестный заголовок раздела — broken')

  group('битые файлы: три варианта, буквы не по порядку, нет раздела вариантов, чужой answer, неизвестный заголовок — всё даёт broken')
}

function bareParseChecks(): void {
  // parseQuestionBody напрямую: убеждаемся, что broken не роняет разбор остальных полей
  const p = parseQuestionBody('## Вопрос\nStem text.\n\n## Варианты\nA. one\n\nB. two\n\nC. three\n')
  assert(p.broken, 'три варианта: broken выставлен')
  assert(p.stem === 'Stem text.', 'условие разбирается даже при битых вариантах')
  assert(p.choices.length === 3, 'разобранные варианты не выбрасываются целиком из-за брака числа')
  group('parseQuestionBody: брак в одном разделе не мешает разбору остальных')
}

// ---- очередь практики -------------------------------------------------------

function pickChecks(): void {
  const q1 = view('q1')
  const q2 = view('q2', { skill: 'Command of Evidence', difficulty: 'Easy' })
  const q3 = view('q3')
  const q4 = view('q4', { difficulty: 'Hard' })
  const broken = view('q5', { broken: true })
  const views = [q1, q2, q3, q4, broken]

  const empty = pickPractice(views, [])
  assert(empty.length === 4, `пустой журнал — все небитые вопросы в очереди, получено ${empty.length}`)
  assert(!empty.some(v => v.qid === 'q5'), 'битый вопрос в очередь не попадает')
  assert(empty.map(v => v.qid).join() === 'q1,q2,q3,q4', 'без истории порядок сохраняется как во входном списке')
  group('pickPractice: пустой журнал отдаёт все небитые вопросы')

  // now зафиксирован (2026-08-24): q1 (последняя попытка верная 08-21, срок +8 = 08-29) ещё
  // не созрел и на эту дату уходит в третью группу; q3 (промах 08-10, срок +2 = 08-12) и
  // q2 (промах 08-15, срок +2 = 08-17) оба уже созрели, отсортированы по сроку
  const now = new Date('2026-08-24T12:00:00+04:00')
  const journal: JournalLine[] = [
    // q1 сначала ответили неверно, потом верно - последняя попытка решает график повтора
    practiceLine({ qid: 'q1', ts: '2026-08-20T10:00:00+04:00', correct: false }),
    practiceLine({ qid: 'q1', ts: '2026-08-21T10:00:00+04:00', correct: true }),
    // q3 неверно давно
    practiceLine({ qid: 'q3', ts: '2026-08-10T10:00:00+04:00', correct: false }),
    // q2 неверно позже q3
    practiceLine({ qid: 'q2', ts: '2026-08-15T10:00:00+04:00', correct: false })
    // q4 в журнале не встречается вовсе
  ]
  const mixed = pickPractice(views, journal, undefined, now)
  assert(mixed.map(v => v.qid).join() === 'q4,q3,q2,q1',
    `новый впереди, созревшие к повтору - от самых просроченных, ещё не созревший верный - в хвосте; получено ${mixed.map(v => v.qid).join()}`)
  group('pickPractice: новые впереди, созревшие к повтору по давности, ещё не созревшие - в хвост')

  const bySkill = pickPractice(views, journal, { skill: 'Command of Evidence' }, now)
  assert(bySkill.length === 1 && bySkill[0].qid === 'q2', 'фильтр по навыку сужает очередь')
  const byDifficulty = pickPractice(views, journal, { difficulty: 'Hard' }, now)
  assert(byDifficulty.length === 1 && byDifficulty[0].qid === 'q4', 'фильтр по сложности сужает очередь')
  const both = pickPractice(views, journal, { skill: 'Rhetorical Synthesis', difficulty: 'Medium' }, now)
  assert(both.map(v => v.qid).join() === 'q3,q1', 'фильтр по навыку и сложности одновременно применяется вместе')
  const none = pickPractice(views, journal, { skill: 'нет такого' }, now)
  assert(none.length === 0, 'фильтр без совпадений отдаёт пустую очередь, а не падает')
  group('pickPractice: фильтр по навыку и по сложности')

  assert(pickPractice([], []).length === 0, 'пустой список вопросов - пустая очередь')
}

// ---- график повтора (P5): промах через PRACTICE_RETRY_WRONG_DAYS, верный - через PRACTICE_RETRY_RIGHT_DAYS
function retryScheduleChecks(): void {
  const qf = view('qf') // свежий, ни разу не отвечен
  const qw = view('qw') // промах 2026-09-05, срок +2 = 2026-09-07
  const qr = view('qr') // верно 2026-09-01, срок +8 = 2026-09-09
  const views = [qf, qw, qr]
  const journal: JournalLine[] = [
    practiceLine({ qid: 'qw', ts: '2026-09-05T10:00:00+04:00', day: '2026-09-05', correct: false }),
    practiceLine({ qid: 'qr', ts: '2026-09-01T10:00:00+04:00', day: '2026-09-01', correct: true })
  ]

  // 2026-09-06: оба ещё не созрели (qw до 09-07, qr до 09-09) - идут хвостом за свежим, по сроку
  const early = pickPractice(views, journal, undefined, new Date('2026-09-06T12:00:00+04:00'))
  assert(early.map(v => v.qid).join() === 'qf,qw,qr',
    `оба ещё не созрели: свежий впереди, хвост по сроку (qw раньше qr); получено ${early.map(v => v.qid).join()}`)

  // 2026-09-08: промах (qw, срок 09-07) уже созрел и встаёт в группу «к повтору» перед verным
  // (qr, срок 09-09), который всё ещё не созрел и остаётся в хвосте
  const mid = pickPractice(views, journal, undefined, new Date('2026-09-08T12:00:00+04:00'))
  assert(mid.map(v => v.qid).join() === 'qf,qw,qr',
    `промах созрел раньше верного независимо от группы; получено ${mid.map(v => v.qid).join()}`)
  assert(practiceDue(views, journal, new Date('2026-09-08T12:00:00+04:00')) === 1,
    'practiceDue на 09-08: созрел только промах (qw), верный (qr) ещё нет')

  // 2026-09-10: оба созрели, порядок по сроку (qw раньше qr)
  const late = pickPractice(views, journal, undefined, new Date('2026-09-10T12:00:00+04:00'))
  assert(late.map(v => v.qid).join() === 'qf,qw,qr',
    `оба созрели, порядок по сроку сохранён; получено ${late.map(v => v.qid).join()}`)
  assert(practiceDue(views, journal, new Date('2026-09-10T12:00:00+04:00')) === 2,
    'practiceDue на 09-10: оба созрели')

  assert(practiceDue(views, journal, new Date('2026-09-06T12:00:00+04:00')) === 0,
    'practiceDue на 09-06: ничего ещё не созрело')
  assert(practiceDue([qf], []) === 0, 'свежий вопрос без попыток не входит в practiceDue')

  group('pickPractice/practiceDue: график повтора - промах через 2 дня, верный через 8, тот же now даёт тот же результат')

  // граница между 09-06 и 09-07 (день созревания qw): срок наступает включительно
  const boundary = pickPractice(views, journal, undefined, new Date('2026-09-07T00:01:00+04:00'))
  assert(boundary.map(v => v.qid).join() === 'qf,qw,qr', 'срок повтора наступает включительно (retryDay <= today)')
  group('pickPractice: срок повтора наступает включительно')
}

// ---- очередь модуля (P6): 27 вопросов подряд, бюджет 32 минуты
function moduleChecks(): void {
  const many = Array.from({ length: 122 }, (_, i) => view(`m${i}`))
  assert(moduleQueue(many, []).length === MODULE_QUESTIONS,
    `при 122 доступных вопросах модуль берёт ровно ${MODULE_QUESTIONS}, получено ${moduleQueue(many, []).length}`)

  const few = Array.from({ length: 20 }, (_, i) => view(`s${i}`))
  assert(moduleQueue(few, []).length === 20, 'при 20 доступных вопросах модуль отдаёт все 20, не выдумывая недостающие')

  assert(moduleQueue([], []).length === 0, 'пустой банк - пустая очередь модуля, а не падение')

  // moduleQueue - это те же первые вопросы, что отдаёт pickPractice, без своей пересортировки
  const now = new Date('2026-09-06T12:00:00+04:00')
  const direct = pickPractice(many, [], undefined, now).slice(0, MODULE_QUESTIONS).map(v => v.qid).join()
  assert(moduleQueue(many, [], now).map(v => v.qid).join() === direct,
    'moduleQueue не переставляет вопросы по-своему - это срез pickPractice')

  assert(Math.round(MODULE_SECONDS / MODULE_QUESTIONS) === PACE_SEC,
    `константы модуля согласованы: MODULE_SECONDS/MODULE_QUESTIONS ≈ PACE_SEC, получено ${MODULE_SECONDS / MODULE_QUESTIONS}`)
  assert(MODULE_QUESTIONS === 27 && MODULE_SECONDS === 32 * 60 && PACE_SEC === 71,
    'константы модуля соответствуют арифметике модуля RW настоящего экзамена')

  group('moduleQueue: 27 вопросов при избытке, все доступные при недостатке, константы согласованы')
}

// ---- сводка -----------------------------------------------------------------

function statsChecks(): void {
  const q1 = view('q1')
  const q2 = view('q2', { skill: 'Command of Evidence' })
  const q3 = view('q3')
  const broken = view('q4', { broken: true })
  const views = [q1, q2, q3, broken]

  const journal: JournalLine[] = [
    practiceLine({ qid: 'q1', correct: false, ts: '2026-08-20T10:00:00+04:00' }),
    practiceLine({ qid: 'q1', correct: true, ts: '2026-08-21T10:00:00+04:00' }),
    practiceLine({ qid: 'q2', correct: false, ts: '2026-08-20T10:00:00+04:00', skill: 'Command of Evidence' })
    // q3 не отвечен вовсе
  ]
  const s = practiceStats(views, journal)
  assert(s.total === 3, `битый вопрос в total не считается, получено ${s.total}`)
  assert(s.solved === 2, `отвечено q1 и q2, получено ${s.solved}`)
  assert(s.correct === 1, `верно решён только q1 (в итоге), получено ${s.correct}`)

  const rs = s.bySkill['Rhetorical Synthesis']
  assert(rs.total === 2 && rs.solved === 1 && rs.correct === 1, `по навыку Rhetorical Synthesis: ${JSON.stringify(rs)}`)
  const ce = s.bySkill['Command of Evidence']
  assert(ce.total === 1 && ce.solved === 1 && ce.correct === 0, `по навыку Command of Evidence: ${JSON.stringify(ce)}`)
  group('practiceStats: сводка по всем вопросам и по каждому навыку, битые исключены')

  const empty = practiceStats([], [])
  assert(empty.total === 0 && empty.solved === 0 && empty.correct === 0 && Object.keys(empty.bySkill).length === 0,
    'пустой набор - пустая сводка, а не деление на ноль')
}

/**
 * F53: подпись кнопки блока практики, когда отвечено на весь банк. Репро судьи -
 * 5 вопросов, все с попыткой, 2 верных: прежний экран печатал «Все вопросы решены»,
 * хотя рядом стояло «2/5 верно».
 */
function summaryLabelChecks(): void {
  assert(practiceSummaryLabel({ total: 5, solved: 3, correct: 3 }) === null,
    'отвечено не на всё (left > 0) - подпись-итог не нужна, кнопка показывает счётчик оставшегося')

  assert(practiceSummaryLabel({ total: 5, solved: 5, correct: 5 }) === 'Все вопросы решены',
    'весь банк отвечен и все ответы верны - честное «Все вопросы решены»')

  const partial = practiceSummaryLabel({ total: 5, solved: 5, correct: 2 })
  assert(partial === 'Все вопросы пройдены, верно 2 из 5: остальные вернутся по графику повторов',
    `репро судьи: отвечено на всё, верно только 2 из 5 - подпись обязана назвать разрыв, получено «${partial}»`)
  assert(partial !== 'Все вопросы решены', 'подпись «Все вопросы решены» запрещена, когда среди ответов есть неверные')

  assert(practiceSummaryLabel({ total: 0, solved: 0, correct: 0 }) === 'Все вопросы решены',
    'пустой банк формально «весь решён» - тем же правилом (correct === total), экран отдельно проверяет total === 0 сам')

  group('practiceSummaryLabel: «решены» только при correct === total, иначе честный разрыв (F53)')
}

// ---- разрезы сверх practiceStats (сложность, неделя, время) -----------------

function breakdownChecks(): void {
  const today = '2026-08-24'

  // семантика byDifficulty = семантика bySkill: вопрос, отвеченный верно со второй
  // попытки, засчитывается верным целиком (не «наполовину»)
  const q1 = view('q1', { difficulty: 'Medium' })
  const q2 = view('q2', { skill: 'Command of Evidence', difficulty: 'Easy' })
  const broken = view('q3', { difficulty: 'Medium', broken: true })
  const views = [q1, q2, broken]
  const j1: JournalLine[] = [
    practiceLine({ qid: 'q1', difficulty: 'Medium', correct: false, ts: '2026-08-20T10:00:00+04:00', day: '2026-08-20' }),
    practiceLine({ qid: 'q1', difficulty: 'Medium', correct: true, ts: '2026-08-21T10:00:00+04:00', day: '2026-08-21' }),
    // ответ на битый вопрос — не должен попасть ни в один разрез
    practiceLine({ qid: 'q3', difficulty: 'Medium', correct: false, ts: '2026-08-21T10:00:00+04:00', day: '2026-08-21' })
  ]
  const bd1 = practiceBreakdown(views, j1, today)
  assert(bd1.byDifficulty['Medium'].total === 1 && bd1.byDifficulty['Medium'].solved === 1 && bd1.byDifficulty['Medium'].correct === 1,
    `byDifficulty Medium: та же семантика «верно», что у bySkill, и битый q3 (той же сложности) не даёт вторую единицу: ${JSON.stringify(bd1.byDifficulty['Medium'])}`)
  assert(bd1.byDifficulty['Easy'].total === 1 && bd1.byDifficulty['Easy'].solved === 0,
    'разрез по сложности: неотвеченный вопрос виден как total без solved')
  group('practiceBreakdown: byDifficulty — та же семантика «решён», что и bySkill; битые вопросы не попадают в разрез')

  // недельная точность считает ПОПЫТКИ, а не вопросы: два неверных ответа на один и тот же
  // вопрос дают 0 из 2, а не 0 из 1 — другая величина, чем «correct» в PracticeGroupStats
  const q4 = view('q4', { difficulty: 'Hard' })
  const j2: JournalLine[] = [
    practiceLine({ qid: 'q4', difficulty: 'Hard', correct: false, ts: '2026-08-22T10:00:00+04:00', day: '2026-08-22' }),
    practiceLine({ qid: 'q4', difficulty: 'Hard', correct: false, ts: '2026-08-23T10:00:00+04:00', day: '2026-08-23' }),
    // за пределами окна в 7 дней (today-6..today) — не считается
    practiceLine({ qid: 'q4', difficulty: 'Hard', correct: true, ts: '2026-08-10T10:00:00+04:00', day: '2026-08-10' })
  ]
  const bd2 = practiceBreakdown([q4], j2, today)
  assert(bd2.week.attempts === 2, `недельные попытки считают строки, а не вопросы: получено ${bd2.week.attempts}`)
  assert(bd2.week.accuracy === 0, `0 верных из 2 попыток — точность 0%, а не как у 0 из 1 вопроса, получено ${bd2.week.accuracy}`)
  group('practiceBreakdown: недельная точность считает попытки, не вопросы — два неверных ответа на один вопрос дают 0 из 2')

  // старая попытка за окном не искажает точность, а свежий верный ответ поднимает её
  const j3: JournalLine[] = [
    ...j2,
    practiceLine({ qid: 'q4', difficulty: 'Hard', correct: true, ts: '2026-08-24T09:00:00+04:00', day: '2026-08-24' })
  ]
  const bd3 = practiceBreakdown([q4], j3, today)
  assert(bd3.week.attempts === 3 && bd3.week.accuracy === 33, `3 попытки за неделю, 1 верная → 33%, получено ${JSON.stringify(bd3.week)}`)

  // среднее время игнорирует строки без sec, а не считает их нулём
  const j4: JournalLine[] = [
    practiceLine({ qid: 'q4', difficulty: 'Hard', correct: true, ts: '2026-08-22T10:00:00+04:00', day: '2026-08-22', sec: 10 }),
    practiceLine({ qid: 'q4', difficulty: 'Hard', correct: false, ts: '2026-08-23T10:00:00+04:00', day: '2026-08-23', sec: 20 }),
    // без sec — не измерена, не должна тянуть среднее к нулю
    practiceLine({ qid: 'q4', difficulty: 'Hard', correct: true, ts: '2026-08-24T10:00:00+04:00', day: '2026-08-24', sec: undefined })
  ]
  const bd4 = practiceBreakdown([q4], j4, today)
  assert(bd4.avgSec === 15, `среднее по двум измеренным строкам (10 и 20), без sec игнорируется: получено ${bd4.avgSec}`)
  group('practiceBreakdown: среднее время считается только по строкам с известным sec')

  // разрез по темпу: measured считает строки с известным sec, slow - только помеченные флагом
  const j5: JournalLine[] = [
    practiceLine({ qid: 'q4', difficulty: 'Hard', correct: true, ts: '2026-08-22T10:00:00+04:00', day: '2026-08-22', sec: 40, slow: false }),
    practiceLine({ qid: 'q4', difficulty: 'Hard', correct: false, ts: '2026-08-23T10:00:00+04:00', day: '2026-08-23', sec: 90, slow: true }),
    // без sec - не измерена и в pace.measured не входит, даже если slow где-то ошибочно выставлен
    practiceLine({ qid: 'q4', difficulty: 'Hard', correct: true, ts: '2026-08-24T10:00:00+04:00', day: '2026-08-24', sec: undefined })
  ]
  const bd5 = practiceBreakdown([q4], j5, today)
  assert(bd5.pace.measured === 2 && bd5.pace.slow === 1,
    `разрез по темпу: 2 измеренные попытки, 1 за бюджетом (PACE_SEC), получено ${JSON.stringify(bd5.pace)}`)
  group('practiceBreakdown: разрез по темпу считает измеренные попытки и долю превысивших PACE_SEC')

  // среднее время и разрез по темпу считаются В ТОМ ЖЕ окне «за 7 дней», что week.attempts,
  // а не по всей истории (F57): старая попытка вне окна не должна тянуть среднее и не должна
  // засчитываться в измеренные для темпа
  const j6: JournalLine[] = [
    practiceLine({ qid: 'q4', difficulty: 'Hard', correct: true, ts: '2026-07-01T10:00:00+04:00', day: '2026-07-01', sec: 600, slow: true }),
    practiceLine({ qid: 'q4', difficulty: 'Hard', correct: true, ts: '2026-08-24T10:00:00+04:00', day: '2026-08-24', sec: 10, slow: false })
  ]
  const bd6 = practiceBreakdown([q4], j6, today)
  assert(bd6.avgSec === 10, `старая попытка вне окна не должна тянуть среднее время: получено ${bd6.avgSec}`)
  assert(bd6.pace.measured === 1 && bd6.pace.slow === 0,
    `старая попытка вне окна не должна попадать в разрез по темпу: получено ${JSON.stringify(bd6.pace)}`)
  group('practiceBreakdown: среднее время и темп считаются за то же окно, что week.attempts, а не за всю историю')

  // пустой журнал - без NaN и без деления на ноль
  const bdEmpty = practiceBreakdown([], [], today)
  assert(bdEmpty.week.attempts === 0 && bdEmpty.week.accuracy === null && bdEmpty.avgSec === null,
    `пустой журнал: ноль попыток, точность и время - null, а не NaN: ${JSON.stringify(bdEmpty)}`)
  assert(Object.keys(bdEmpty.byDifficulty).length === 0, 'пустой набор вопросов - пустой разрез по сложности')
  assert(bdEmpty.pace.measured === 0 && bdEmpty.pace.slow === 0, 'пустой журнал - пустой разрез по темпу, а не NaN')
  group('practiceBreakdown: пустой журнал не даёт NaN и деления на ноль')
}

// ---- SPR (математика, answer_type: spr): вопрос с вписываемым ответом, без вариантов --------

const SPR_MD = `---
type: question
qid: spr-01
assessment: SAT
test: Math
domain: Algebra
skill: Linear equations
difficulty: Medium
answer_type: spr
answers:
  - '7/3'
  - '2.333'
added: '2026-09-20'
---

## Вопрос

Solve for x: 3x = 7.

## Разбор

x = 7/3.
`

function sprParseChecks(): void {
  const v = questionView(qrec(SPR_MD))
  assert(!v.broken, `spr-вопрос без раздела «## Варианты» не битый, получено broken=${v.broken}`)
  assert(v.kind === 'spr', 'kind = spr у answer_type: spr')
  assert(v.choices.length === 0, 'у spr-вопроса вариантов нет')
  assert(v.answers.join(',') === '7/3,2.333', 'принятые формы ответа разобраны из frontmatter answers')
  assert(v.section === 'math', 'test: Math → раздел math')
  group('SPR: вопрос без раздела «## Варианты» разбирается целиком, не битый')

  // spr-вопрос, у которого файл всё же содержит раздел «## Варианты» — брак: вариантов у spr
  // быть не должно по устройству, лишний раздел значит рассинхрон инструмента выгрузки
  const withChoices = SPR_MD.replace(
    '## Разбор',
    '## Варианты\n\nA. one\n\nB. two\n\nC. three\n\nD. four\n\n## Разбор'
  )
  const bv = questionView(qrec(withChoices))
  assert(bv.broken, 'spr-вопрос с разделом «## Варианты» в файле — broken')
  group('SPR: раздел «## Варианты» у spr-вопроса — брак')

  // spr-вопрос без единой принятой формы ответа — сверять нечем, брак
  const noAnswers = SPR_MD.replace(/answers:\n(\s+- .+\n)+/, 'answers: []\n')
  const nv = questionView(qrec(noAnswers))
  assert(nv.broken, 'spr-вопрос с пустым answers — broken (сверять ответ не с чем)')
  assert(nv.answers.length === 0, 'пустой answers остаётся пустым списком, а не выдуманным')
  group('SPR: пустой список answers — брак')

  // parseQuestionBody напрямую с флагом spr — тот же брак на голом разборе
  const bare = parseQuestionBody('## Вопрос\nSolve.\n\n## Варианты\nA. one\n\nB. two\n\nC. three\n\nD. four\n', true)
  assert(bare.broken, 'parseQuestionBody(body, spr=true) считает раздел «## Варианты» браком')
  group('parseQuestionBody: флаг spr запрещает раздел «## Варианты»')
}

// ---- раздел экзамена (RW/математика): practiceSectionOf ---------------------

function sectionOfChecks(): void {
  assert(practiceSectionOf({ test: 'Math' }) === 'math', 'test: Math → math')
  assert(practiceSectionOf({ test: 'math' }) === 'math', 'test сравнивается без учёта регистра')
  assert(practiceSectionOf({ test: 'Reading and Writing' }) === 'rw', 'test: Reading and Writing → rw')

  // без test — по домену математики банка (коды H/P/Q/S и их названия)
  assert(practiceSectionOf({ domain: 'H' }) === 'math', 'домен H без test → math')
  assert(practiceSectionOf({ domain: 'P' }) === 'math', 'домен P без test → math')
  assert(practiceSectionOf({ domain: 'Q' }) === 'math', 'домен Q без test → math')
  assert(practiceSectionOf({ domain: 'S' }) === 'math', 'домен S без test → math')
  assert(practiceSectionOf({ domain: 'Algebra' }) === 'math', 'домен «Algebra» без test → math')

  // ни test, ни математический домен — RW, как весь банк до 24.09.2026
  assert(practiceSectionOf({ domain: 'Expression of Ideas' }) === 'rw', 'домен RW без test → rw')
  assert(practiceSectionOf({}) === 'rw', 'ни test, ни домен — по умолчанию rw')

  group('practiceSectionOf: test решает раздел, без test — домен математики банка (H/P/Q/S, Algebra), иначе rw')
}

// ---- вердикт ответа: буква у mcq, число (с допуском) у spr ------------------

function verdictChecks(): void {
  const mcq = view('m1', { kind: 'mcq', answer: 'B' })
  assert(practiceVerdict(mcq, 'b') === true, 'mcq: буква сверяется без учёта регистра')
  assert(practiceVerdict(mcq, 'B') === true, 'mcq: точное совпадение буквы — верно')
  assert(practiceVerdict(mcq, 'A') === false, 'mcq: другая буква — неверно')
  assert(practiceVerdict(view('m2', { kind: 'mcq', answer: '' }), 'A') === null,
    'mcq без известного ответа (answer пуст) — вердикт неизвестен, null')

  const spr = view('s1', { kind: 'spr', answer: '', answers: ['7/3', '2.333'] })
  assert(practiceVerdict(spr, '7/3') === true, 'spr: точная дробь из answers — верно')
  assert(practiceVerdict(spr, '14/6') === true, 'spr: эквивалентная дробь (14/6 = 7/3) — верно')
  assert(practiceVerdict(spr, '2.333') === true, 'spr: десятичная форма из answers — верно')
  assert(practiceVerdict(spr, '2.4') === false, 'spr: неверное значение — неверно, не null')
  assert(practiceVerdict(spr, '') === false, 'spr: пустой ответ — неверно (typed пуст), а не null')
  assert(practiceVerdict(spr, '   ') === false, 'spr: ответ из одних пробелов — неверно, как пустой')

  const noKey = view('s2', { kind: 'spr', answer: '', answers: [] })
  assert(practiceVerdict(noKey, '7/3') === null, 'spr без ключа (answers пуст) — вердикт неизвестен, null')

  group('practiceVerdict: mcq по букве, spr по числу с допуском (checkNumeric), нет ключа — null')
}

// ---- модуль и темп по разделу (математика) -----------------------------------

function moduleAndPaceBySectionChecks(): void {
  const mathViews = Array.from({ length: 40 }, (_, i) => view(`mm${i}`, { section: 'math', kind: 'spr', answer: '', answers: ['1'] }))
  const q = moduleQueue(mathViews, [], new Date('2026-09-24T12:00:00+04:00'), 'math')
  assert(q.length <= 22, `moduleQueue(..., 'math') отдаёт не больше 22 вопросов, получено ${q.length}`)
  assert(q.length === 22, `при избытке математика заполняет весь модуль (22), получено ${q.length}`)
  assert(MODULE_BY_SECTION.math.questions === 22 && MODULE_BY_SECTION.math.seconds === 35 * 60,
    'модуль математики: 22 вопроса, 35 минут')

  assert(paceSecOf(view('r1', { section: 'rw' })) === 71, 'темп RW — 71 с')
  assert(paceSecOf(view('m1', { section: 'math' })) === 95, 'темп математики — 95 с')

  group('moduleQueue/paceSecOf: у математики свой модуль (≤22 вопросов) и свой темп (95 с) отдельно от RW (71 с)')
}

// ---- формат html (математика College Board: MathML, рисунки, таблицы) --------

function htmlFormatChecks(): void {
  const htmlMd = SPR_MD.replace('---\n\n## Вопрос', 'format: html\n---\n\n## Вопрос')
  const v = questionView(qrec(htmlMd))
  assert(v.html === true, 'format: html во frontmatter → html: true')
  assert(!v.broken, 'html-вопрос разбирается как обычный spr, брака формат сам по себе не добавляет')

  const plain = questionView(qrec(SPR_MD))
  assert(plain.html === false, 'без format: html — html: false')

  group('questionView: format: html → QuestionView.html true, иначе false')
}

// ---- обновление схемы БД со 2 на 3 -------------------------------------------

async function dbMigrationCheck(): Promise<void> {
  // 1. «уже установленное PWA» на схеме v2 с настоящими данными пользователя
  const pre = await openDB('sat-srs', 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('cards', { keyPath: 'path' })
        const j = d.createObjectStore('journal', { keyPath: 'id' })
        j.createIndex('by_day', 'day')
        d.createObjectStore('kv')
      }
      if (oldVersion < 2) {
        d.createObjectStore('readings', { keyPath: 'path' })
      }
    }
  })
  await pre.put('cards', { path: 'Учёба/Карточки/abstract.md', sha: 'x', fm: { word: 'abstract' }, body: '', dirty: 0 })
  await pre.put('journal', { id: 'j-1', type: 'review', ts: '2026-08-01T10:00:00+04:00', day: '2026-08-01', slug: 'abstract' })
  await pre.put('readings', { path: 'Учёба/Чтение/2-01-reef.md', sha: 'y', fm: { title: 'Reef' }, body: 'text' })
  await pre.put('kv', 'token-value', 'lastSyncAt')
  pre.close()

  // 2. штатный db.ts открывает ту же базу версией 3 — это и есть проверяемый upgrade()
  const cardsAfter = await getAllCards()
  const journalAfter = await getAllJournal()
  const readingsAfter = await getAllReadings()
  const questionsAfter = await getAllQuestions()

  assert(cardsAfter.length === 1 && cardsAfter[0].fm.word === 'abstract', 'карточки пережили обновление схемы со 2 на 3')
  assert(journalAfter.length === 1 && journalAfter[0].slug === 'abstract', 'журнал пережил обновление схемы со 2 на 3')
  assert(readingsAfter.length === 1 && readingsAfter[0].fm.title === 'Reef', 'тексты для чтения пережили обновление схемы со 2 на 3')
  assert(questionsAfter.length === 0, 'новое хранилище questions создано пустым, а не отсутствует и не падает')
  assert((await kvGet('lastSyncAt')) === 'token-value', 'служебные ключи (kv) переживают обновление схемы')

  // 3. новое хранилище реально пишет и читает
  await applyQuestionsPull(
    [{ path: 'Учёба/Вопросы/q.md', sha: 'q1', fm: { qid: 'q1' }, body: '' }],
    new Set(['Учёба/Вопросы/q.md'])
  )
  const afterPull = await getAllQuestions()
  assert(afterPull.length === 1 && afterPull[0].fm.qid === 'q1', 'хранилище questions рабочее сразу после обновления схемы')

  group('обновление схемы БД со 2 на 3: карточки, журнал, тексты и kv не теряются; questions создаётся пустым и рабочим')
}

async function main(): Promise<void> {
  console.log('SRS практика — разбор вопроса, очередь сессии, сводка, обновление схемы БД')
  goodFileChecks()
  noRationaleChecks()
  brokenChecks()
  bareParseChecks()
  sprParseChecks()
  sectionOfChecks()
  verdictChecks()
  moduleAndPaceBySectionChecks()
  htmlFormatChecks()
  pickChecks()
  retryScheduleChecks()
  moduleChecks()
  statsChecks()
  summaryLabelChecks()
  breakdownChecks()
  await dbMigrationCheck()
  console.log(`\nВсе проверки практики пройдены (${passed} групп).`)
}

main().catch(e => {
  console.error('\n✗ ТЕСТ ПРАКТИКИ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
})
