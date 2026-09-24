/**
 * Тесты scripts/qbank-import.mjs на синтетических фикстурах (сеть к collegeboard.org из этой
 * среды закрыта — живой прогон не проверялся, см. заголовок скрипта).
 *
 * Проверяется то, что действительно рискует сломать приложение: готовый md-файл, который
 * пишет скрипт, обязан разбираться ТЕМ ЖЕ парсером, что и живая колода — parseMd (yamlfm.ts)
 * + questionView (practice.ts), — без broken, с верным разделом (math/rw), kind/answer(s)
 * и html=true. Плюс отдельно: разбор ответа API (mcq с MathML `<mfenced>` и вложенностью,
 * spr с двумя формами ответа), разбор disclosed JSON (mcq и неизвестная схема) и защита от
 * перезаписи уже существующего файла вопроса.
 *
 * Запуск: `npm run test:qbank` (esbuild бандлит .mjs+.ts вместе и node исполняет).
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMd } from '../src/lib/yamlfm'
import { questionView } from '../src/lib/practice'
import type { QuestionRec } from '../src/lib/types'
import {
  mfencedToMrow, stripOuterP, oneLine, difficultyLabel, slugify, filenameFor,
  parseApiQuestion, parseDisclosedQuestion, buildQuestionMarkdown, questionFileExists, todayKey
} from '../scripts/qbank-import.mjs'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

function rec(md: string, path = 'Учёба/Вопросы/тест-easy-11112222.md'): QuestionRec {
  const { fm, body, broken } = parseMd(md)
  return { path, sha: null, fm, body, broken }
}

// ---- mfencedToMrow ----------------------------------------------------------

function mfencedChecks(): void {
  const flat = '<mfenced open="(" close=")"><mn>2</mn><mn>3</mn></mfenced>'
  const flatOut = mfencedToMrow(flat)
  assert(!flatOut.includes('<mfenced'), 'mfenced плоский: тег не должен остаться')
  assert(flatOut === '<mrow><mo>(</mo><mn>2</mn><mo>,</mo><mn>3</mn><mo>)</mo></mrow>',
    `mfenced плоский → mrow с запятой по умолчанию, получили: ${flatOut}`)
  group('mfencedToMrow: плоский случай, разделитель по умолчанию')

  const custom = '<mfenced open="[" close="]" separators=";"><mi>x</mi><mi>y</mi><mi>z</mi></mfenced>'
  const customOut = mfencedToMrow(custom)
  assert(customOut === '<mrow><mo>[</mo><mi>x</mi><mo>;</mo><mi>y</mi><mo>;</mo><mi>z</mi><mo>]</mo></mrow>',
    `mfenced с кастомными open/close/separators, получили: ${customOut}`)
  group('mfencedToMrow: кастомные open/close/separators')

  const nested = '<math><mfenced open="(" close=")"><mfenced open="{" close="}"><mn>1</mn></mfenced><mn>2</mn></mfenced></math>'
  const nestedOut = mfencedToMrow(nested)
  assert(!nestedOut.includes('<mfenced'), 'вложенный mfenced: ни одного тега не должно остаться')
  assert(nestedOut === '<math><mrow><mo>(</mo><mrow><mo>{</mo><mn>1</mn><mo>}</mo></mrow><mo>,</mo><mn>2</mn><mo>)</mo></mrow></math>',
    `вложенный mfenced развёрнут неверно, получили: ${nestedOut}`)
  group('mfencedToMrow: вложенность обрабатывается изнутри наружу')

  const untouched = '<p>без mfenced</p>'
  assert(mfencedToMrow(untouched) === untouched, 'строка без mfenced не должна меняться')
  group('mfencedToMrow: строка без mfenced не трогается')
}

// ---- stripOuterP / oneLine ---------------------------------------------------

function textHelpersChecks(): void {
  assert(stripOuterP('<p>A</p>') === 'A', 'внешний одиночный <p> снимается')
  assert(stripOuterP('<p>A</p><p>B</p>') === '<p>A</p><p>B</p>', 'два параграфа — не единый внешний <p>, не трогаем')
  assert(stripOuterP('no p here') === 'no p here', 'без <p> — без изменений')
  group('stripOuterP: снимает только настоящий единственный внешний <p>')

  const multi = 'line one\nline two\r\nline three'
  assert(oneLine(multi) === 'line one line two line three', 'переводы строк схлопнуты в пробелы')
  assert(!oneLine('## Вопрос внутри текста').startsWith('##'), 'результат не должен начинаться с "##"')
  group('oneLine: одна строка, не начинается с "##"')
}

// ---- difficultyLabel / slugify / filenameFor ---------------------------------

function namingChecks(): void {
  assert(difficultyLabel('E') === 'Easy' && difficultyLabel('M') === 'Medium' && difficultyLabel('H') === 'Hard',
    'коды сложности E/M/H → Easy/Medium/Hard')
  assert(slugify('Rhetorical Synthesis') === 'rhetorical-synthesis', 'slugify: пробелы → дефисы, нижний регистр')
  assert(filenameFor('Rhetorical Synthesis', 'M', 'afec1a70') === 'rhetorical-synthesis-medium-afec1a70.md',
    'filenameFor: slug(skill)-difficulty-questionId.md')
  group('difficultyLabel/slugify/filenameFor')
}

// ---- parseApiQuestion (get-question) ------------------------------------------

const API_MCQ = {
  type: 'mcq',
  stimulus: '<p>A passage stimulus\nwith a line break.</p>',
  stem: '<p>What is <math><mfenced open="(" close=")"><mn>2</mn><mn>3</mn></mfenced></math>?</p>',
  answerOptions: [
    { id: 'opt-a', content: '<p>1</p>' },
    { id: 'opt-b', content: '<p>2</p>' },
    { id: 'opt-c', content: '<p>3</p>' },
    { id: 'opt-d', content: '<p>4</p>' }
  ],
  correct_answer: ['opt-b'],
  rationale: '<p>Because option B is correct.</p>'
}

const API_SPR = {
  type: 'spr',
  stimulus: '',
  stem: '<p>Enter the value of x.</p>',
  correct_answer: ['7/3', '2.333'],
  rationale: '<p>Solve the equation.</p>'
}

function apiParseChecks(): void {
  const mcq = parseApiQuestion(API_MCQ)
  assert(mcq.kind === 'mcq' && mcq.answer === 'B', `mcq: id opt-b → буква B по порядку, получили ${JSON.stringify(mcq)}`)
  assert(mcq.choices.length === 4 && mcq.choices[0].letter === 'A' && mcq.choices[3].letter === 'D',
    'mcq: 4 варианта, буквы A..D по порядку массива')
  group('parseApiQuestion: mcq, id → буква по порядку answerOptions')

  const spr = parseApiQuestion(API_SPR)
  assert(spr.kind === 'spr' && spr.answers.length === 2 && spr.answers[0] === '7/3' && spr.answers[1] === '2.333',
    'spr: обе формы ответа сохранены')
  group('parseApiQuestion: spr, обе формы ответа')

  const unknown = parseApiQuestion({ type: 'weird' })
  assert(unknown.unknownSchema === true, 'незнакомый type → unknownSchema')
  group('parseApiQuestion: незнакомая схема помечается, не падает')
}

// ---- parseDisclosedQuestion ----------------------------------------------------

const DISCLOSED_MCQ = [{
  prompt: '<p>Passage stimulus.</p>',
  body: '<p>Which choice completes the text?</p>',
  answer: {
    style: 'Multiple Choice',
    choices: {
      a: { body: '<p>alpha</p>' },
      b: { body: '<p>beta</p>' },
      c: { body: '<p>gamma</p>' },
      d: { body: '<p>delta</p>' }
    },
    correct_choice: 'c',
    rationale: '<p>Gamma fits the tone.</p>'
  }
}]

const DISCLOSED_UNKNOWN = [{
  body: '<p>Some question.</p>',
  answer: {
    style: 'Something Else',
    rationale: '<p>No usable answer field here.</p>'
  }
}]

function disclosedParseChecks(): void {
  const mcq = parseDisclosedQuestion(DISCLOSED_MCQ)
  assert(mcq.kind === 'mcq' && mcq.answer === 'C', `disclosed mcq: correct_choice c → C, получили ${JSON.stringify(mcq)}`)
  assert(mcq.choices.map((c: any) => c.letter).join('') === 'ABCD', 'disclosed mcq: буквы всегда A..D по порядку a..d')
  group('parseDisclosedQuestion: mcq (4 choices + correct_choice)')

  const unknown = parseDisclosedQuestion(DISCLOSED_UNKNOWN)
  assert(unknown.unknownSchema === true, 'disclosed без 4 choices и без строкового поля ответа → unknownSchema')
  group('parseDisclosedQuestion: неизвестная схема сохраняет сырьё, не падает')
}

// ---- сборка файла + разбор приложением -----------------------------------------

function fileRoundtripChecks(): void {
  const apiMcq = parseApiQuestion(API_MCQ)
  apiMcq.stem = mfencedToMrow(apiMcq.stem)
  const mdMcq = buildQuestionMarkdown(
    { qid: 'afec1a70', testLabel: 'Math', domain: 'Advanced Math', skill: 'Equivalent expressions', difficultyCode: 'M', added: todayKey() },
    apiMcq
  )
  const mcqRec = rec(mdMcq, 'Учёба/Вопросы/equivalent-expressions-medium-afec1a70.md')
  assert(!mcqRec.broken, 'frontmatter mcq-файла обязан разбираться (parseMd)')
  const mcqView = questionView(mcqRec)
  assert(!mcqView.broken, `questionView mcq не должен быть broken: ${JSON.stringify(mcqView)}`)
  assert(mcqView.section === 'math', 'test: "Math" → section math')
  assert(mcqView.kind === 'mcq', 'kind mcq')
  assert(mcqView.answer === 'B', `answer должен остаться B, получили ${mcqView.answer}`)
  assert(mcqView.html === true, 'format: html → html=true')
  assert(mcqView.choices.length === 4, '4 варианта после разбора')
  assert(mcqView.stem.includes('<mrow>') && !mcqView.stem.includes('<mfenced'), 'mfenced в stem обязан быть развёрнут до записи файла')
  group('файл mcq (API, с MathML mfenced) читается приложением без брака')

  const apiSpr = parseApiQuestion(API_SPR)
  const mdSpr = buildQuestionMarkdown(
    { qid: '9911aabb', testLabel: 'Math', domain: 'Algebra', skill: 'Linear equations in one variable', difficultyCode: 'E', added: todayKey() },
    apiSpr
  )
  const sprRec = rec(mdSpr, 'Учёба/Вопросы/linear-equations-in-one-variable-easy-9911aabb.md')
  assert(!sprRec.broken, 'frontmatter spr-файла обязан разбираться')
  const sprView = questionView(sprRec)
  assert(!sprView.broken, `questionView spr не должен быть broken: ${JSON.stringify(sprView)}`)
  assert(sprView.kind === 'spr', 'kind spr')
  assert(sprView.answers.length === 2 && sprView.answers.includes('7/3') && sprView.answers.includes('2.333'),
    'обе формы ответа spr сохранены во frontmatter и разобраны обратно')
  assert(sprView.choices.length === 0, 'у spr вариантов быть не должно')
  group('файл spr (две формы ответа) читается приложением без брака')

  const discMcq = parseDisclosedQuestion(DISCLOSED_MCQ)
  const mdDisc = buildQuestionMarkdown(
    { qid: '77778888', testLabel: 'Reading and Writing', domain: 'Craft and Structure', skill: 'Words in Context', difficultyCode: 'H', added: todayKey() },
    discMcq
  )
  const discRec = rec(mdDisc, 'Учёба/Вопросы/words-in-context-hard-77778888.md')
  assert(!discRec.broken, 'frontmatter disclosed mcq-файла обязан разбираться')
  const discView = questionView(discRec)
  assert(!discView.broken, `questionView disclosed mcq не должен быть broken: ${JSON.stringify(discView)}`)
  assert(discView.section === 'rw', 'test: "Reading and Writing" → section rw')
  assert(discView.answer === 'C', 'answer из correct_choice сохранён')
  group('файл disclosed mcq читается приложением без брака (section rw)')
}

// ---- защита от перезаписи -------------------------------------------------------

function noOverwriteChecks(): void {
  const dir = mkdtempSync(join(tmpdir(), 'qbank-test-'))
  try {
    writeFileSync(join(dir, 'old-skill-medium-deadbeef.md'), '---\nqid: "deadbeef"\n---\nстарый файл\n', 'utf8')
    assert(questionFileExists(dir, 'deadbeef') === true, 'файл с суффиксом -<qid>.md обязан считаться существующим')
    assert(questionFileExists(dir, 'cafebabe') === false, 'другой qid не должен считаться существующим')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  group('questionFileExists: существующий вопрос по qid не перезаписывается')
}

mfencedChecks()
textHelpersChecks()
namingChecks()
apiParseChecks()
disclosedParseChecks()
fileRoundtripChecks()
noOverwriteChecks()

console.log(`qbank-import: ${passed} групп проверок пройдено`)
