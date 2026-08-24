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
import { parseQuestionBody, questionView, pickPractice, practiceStats, practiceBreakdown } from '../src/lib/practice'
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
    stem: 'Stem.',
    choices: [
      { letter: 'A', text: 'a' }, { letter: 'B', text: 'b' },
      { letter: 'C', text: 'c' }, { letter: 'D', text: 'd' }
    ],
    answer: 'A',
    rationale: 'Rationale.',
    added: '2026-08-24',
    broken: false,
    ...over
  }
}

let idSeq = 0
function practiceLine(o: Partial<JournalLine> & { qid: string }): JournalLine {
  idSeq++
  return {
    id: `p-${idSeq}`,
    v: 1,
    type: 'practice',
    ts: '2026-08-24T10:00:00+04:00',
    ms: 0,
    day: '2026-08-24',
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

  const journal: JournalLine[] = [
    // q1 сначала ответили неверно, потом верно — считается решённым верно, уходит в конец
    practiceLine({ qid: 'q1', ts: '2026-08-20T10:00:00+04:00', correct: false }),
    practiceLine({ qid: 'q1', ts: '2026-08-21T10:00:00+04:00', correct: true }),
    // q3 неверно давно
    practiceLine({ qid: 'q3', ts: '2026-08-10T10:00:00+04:00', correct: false }),
    // q2 неверно позже q3
    practiceLine({ qid: 'q2', ts: '2026-08-15T10:00:00+04:00', correct: false })
    // q4 в журнале не встречается вовсе
  ]
  const mixed = pickPractice(views, journal)
  assert(mixed.map(v => v.qid).join() === 'q4,q3,q2,q1',
    `новый вопрос впереди, неверные — от самых давних, верно решённый — в конце; получено ${mixed.map(v => v.qid).join()}`)
  group('pickPractice: новые впереди, неверные по давности, верно решённые — в конец')

  const bySkill = pickPractice(views, journal, { skill: 'Command of Evidence' })
  assert(bySkill.length === 1 && bySkill[0].qid === 'q2', 'фильтр по навыку сужает очередь')
  const byDifficulty = pickPractice(views, journal, { difficulty: 'Hard' })
  assert(byDifficulty.length === 1 && byDifficulty[0].qid === 'q4', 'фильтр по сложности сужает очередь')
  const both = pickPractice(views, journal, { skill: 'Rhetorical Synthesis', difficulty: 'Medium' })
  assert(both.map(v => v.qid).join() === 'q3,q1', 'фильтр по навыку и сложности одновременно применяется вместе')
  const none = pickPractice(views, journal, { skill: 'нет такого' })
  assert(none.length === 0, 'фильтр без совпадений отдаёт пустую очередь, а не падает')
  group('pickPractice: фильтр по навыку и по сложности')

  assert(pickPractice([], []).length === 0, 'пустой список вопросов — пустая очередь')
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
    'пустой набор — пустая сводка, а не деление на ноль')
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

  // пустой журнал — без NaN и без деления на ноль
  const bdEmpty = practiceBreakdown([], [], today)
  assert(bdEmpty.week.attempts === 0 && bdEmpty.week.accuracy === null && bdEmpty.avgSec === null,
    `пустой журнал: ноль попыток, точность и время — null, а не NaN: ${JSON.stringify(bdEmpty)}`)
  assert(Object.keys(bdEmpty.byDifficulty).length === 0, 'пустой набор вопросов — пустой разрез по сложности')
  group('practiceBreakdown: пустой журнал не даёт NaN и деления на ноль')
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
  pickChecks()
  statsChecks()
  breakdownChecks()
  await dbMigrationCheck()
  console.log(`\nВсе проверки практики пройдены (${passed} групп).`)
}

main().catch(e => {
  console.error('\n✗ ТЕСТ ПРАКТИКИ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
})
