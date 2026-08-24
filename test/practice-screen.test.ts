/**
 * Тесты ЭКРАНА практики (Practice.tsx) — того, что не покрывает test/practice.test.ts (слой
 * данных). Тот же стиль, что у test/reading.test.ts: чистая логика прогоняется целиком в node
 * (`practiceView.ts` — разбор условия и подпись отсутствующего разбора, вынесены из экрана по
 * тому же принципу, что `reading.ts` вынесен из Reading.tsx: без React и без базы, значит
 * тестируется исполнением, а не текстом исходника), а то, что нельзя прогнать без DOM
 * (собирает ли экран очередь через pickPractice, перемешивает ли варианты, сколько раз
 * зовёт logPractice), проверяется структурно через screenSource — как в reading.test.ts
 * screenChecks().
 *
 * Запуск: `npm run test:practice-screen` (esbuild бандлит файл и node его исполняет).
 */
import { parseStemBlocks, rationaleText } from '../src/lib/practiceView'
import type { QuestionView } from '../src/lib/types'
import { screenSource } from './screen-source'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

function view(over: Partial<QuestionView> = {}): QuestionView {
  return {
    path: 'Учёба/Вопросы/q1.md',
    qid: 'q1',
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

// ---- разбор условия: абзацы и список заметок --------------------------------

function stemChecks(): void {
  const withNotes = [
    'While researching a topic, a student has taken the following notes:',
    '',
    '- As engineered structures, many bird nests are uniquely flexible yet cohesive.',
    '- A research team led by Yashraj Bhosale wanted to better understand the mechanics.',
    '',
    'Which choice most effectively uses relevant information from the notes?'
  ].join('\n')
  const blocks = parseStemBlocks(withNotes)
  assert(blocks.length === 3, `три блока — вступление, список, вопрос; получено ${blocks.length}`)
  assert(blocks[0].kind === 'p' && blocks[0].lines.join(' ').startsWith('While researching'),
    'первый блок — обычный абзац')
  assert(blocks[1].kind === 'ul' && blocks[1].lines.length === 2,
    `строки "- " собраны в список из двух заметок, получено ${blocks[1].kind}/${blocks[1].lines.length}`)
  assert(blocks[1].lines[0] === 'As engineered structures, many bird nests are uniquely flexible yet cohesive.',
    'дефис-маркер срезан, текст заметки цел')
  assert(blocks[2].kind === 'p' && blocks[2].lines.join(' ').startsWith('Which choice'),
    'вопрос после списка — снова обычный абзац, а не хвост списка')
  group('parseStemBlocks: список заметок студента ("- ") распознан отдельно от прозы')

  const noNotes = 'Plain sentence one.\n\nPlain sentence two spans\ntwo lines.'
  const plain = parseStemBlocks(noNotes)
  assert(plain.length === 2, `два абзаца, получено ${plain.length}`)
  assert(plain.every(b => b.kind === 'p'), 'условие без заметок — только абзацы, списков не выдумано')
  assert(plain[1].lines.join(' ') === 'Plain sentence two spans two lines.',
    'перенос строки внутри абзаца склеивается пробелом, а не пропадает и не рвёт абзац')
  group('parseStemBlocks: условие без списка не порождает список')

  assert(parseStemBlocks('').length === 0, 'пустое условие не роняет разбор и не даёт блоков')
  assert(parseStemBlocks('   \n\n   ').length === 0, 'условие из одних пробелов — пусто')
  group('parseStemBlocks: пустое условие не падает')

  // одиночная заметка без второй строки — тоже список, а не абзац с потерянным маркером
  const one = parseStemBlocks('- Single note only.')
  assert(one.length === 1 && one[0].kind === 'ul' && one[0].lines[0] === 'Single note only.',
    'одна заметка — список из одного пункта, маркер срезан')
  group('parseStemBlocks: единственная заметка распознаётся как список')
}

// ---- разбор без «## Разбор» ---------------------------------------------------

function rationaleChecks(): void {
  assert(rationaleText(view({ rationale: 'Choice A is the best answer.' })) === 'Choice A is the best answer.',
    'непустой разбор возвращается как есть')
  const fallback = rationaleText(view({ rationale: '' }))
  assert(fallback.length > 0, 'у вопроса без раздела «## Разбор» подпись непустая — не молчим о пустоте')
  assert(!fallback.includes('Choice'), 'подпись отсутствия разбора — не выдуманный текст разбора')
  group('rationaleText: пустой разбор даёт честную подпись, а не пустую строку')
}

// ---- структурные проверки экрана ---------------------------------------------

function screenChecks(): void {
  const prac = screenSource('Practice.tsx')

  // очередь — только через pickPractice, без своей сортировки поверх (сортировка чипов
  // навыка/сложности — это список фильтров, а не очередь вопросов, её трогать можно)
  assert(prac.includes('pickPractice('), 'очередь сессии собирается через pickPractice')
  assert(/available\s*=\s*useMemo\(\s*\(\)\s*=>\s*pickPractice\(/.test(prac),
    'очередь (available) — прямой результат pickPractice, без досортировки поверх него')
  assert(!/available\.sort\(|queue\.sort\(/.test(prac),
    'очередь сессии не досортировывается по-своему после pickPractice')
  group('структурно: очередь практики строится только pickPractice')

  // порядок вариантов не трогается: ни shuffleOnce, ни какого-либо другого перемешивания
  assert(!prac.includes('shuffleOnce'), 'экран практики не зовёт shuffleOnce — буквы привязаны к разбору')
  assert(!/\brandom\(/i.test(prac) && !prac.includes('Math.random'),
    'варианты не переставляются случайно ни в каком виде')
  assert(/choices\.map\(/.test(prac), 'варианты рисуются прямым map по view.choices — в исходном порядке')
  group('структурно: порядок вариантов A–D не перемешивается')

  // logPractice — ровно один вызов на отвеченный вопрос, с выбранной буквой
  const calls = prac.match(/logPractice\(/g) ?? []
  assert(calls.length === 1, `logPractice должен вызываться из одного места экрана, найдено ${calls.length}`)
  assert(/logPractice\(view,\s*picked,/.test(prac),
    'logPractice получает именно выбранную букву (picked), а не константу или view.answer')
  assert(/logged\.current/.test(prac),
    'вызов logPractice защищён флагом от повторной записи на том же вопросе')
  group('структурно: logPractice зовётся один раз на вопрос и получает выбор ученика')

  // пустой каталог вопросов — сообщение, а не пустой экран
  assert(prac.includes('views.length === 0'), 'пустой каталог вопросов проверяется явно')
  assert(/appear|Вопросы появятся/i.test(prac) || prac.includes('синхронизации'),
    'пустой каталог вопросов даёт понятное сообщение, а не пустой экран')
  group('структурно: пустой каталог вопросов не оставляет экран пустым')

  // разбор рисуется через rationaleText — вопрос без «## Разбор» не показывает пустой блок
  assert(prac.includes('rationaleText('), 'разбор выводится через rationaleText, а не сырым view.rationale')
  group('структурно: разбор без текста не превращается в пустой блок')

  // условие рисуется через parseStemBlocks — список заметок остаётся списком, а не абзацем
  assert(prac.includes('parseStemBlocks('), 'условие разбирается на блоки через parseStemBlocks')
  assert(prac.includes("kind === 'ul'") && prac.includes('<ul'),
    'блок-список рисуется тегом <ul>, а не абзацем')
  group('структурно: список заметок студента верстается списком')

  // экран не пишет в базу мимо store и не зовёт модель
  assert(!/putJournal/.test(prac), 'экран не пишет в базу мимо store')
  assert(!/fetch\(|openai|anthropic/i.test(prac), 'экран не зовёт модель напрямую')
  group('структурно: экран пишет только через store.logPractice')

  // отметка незнакомого слова: источник — questionSrc, не readingSrc и не cardSrc
  assert(prac.includes("import Markable from '../components/Markable'"), 'экран подключает Markable')
  assert(prac.includes('questionSrc('), 'источник отметки — questionSrc(view.qid), а не строка на месте')
  assert(!prac.includes('readingSrc') && !prac.includes('cardSrc('),
    'экран практики не пишет отметок в источники текста или карточки колоды')
  const markableCount = (prac.match(/<Markable/g) ?? []).length
  assert(markableCount >= 3,
    `Markable используется в условии, вариантах и разборе — найдено вхождений: ${markableCount}`)
  group('структурно: отметка слова пишется в собственный источник вопроса (questionSrc)')

  // до ответа отмечать можно только в условии: вариант — кнопка выбора, а не div,
  // и disabled-кнопка (которая гасит клики по вложенным словам) не используется вовсе
  assert(!/disabled={confirmed}/.test(prac),
    'вариант ответа не гасится disabled: тап по слову внутри disabled-кнопки не доходит')
  assert(prac.includes('confirmed ? <Markable'),
    'текст варианта размечается Markable только когда вопрос уже подтверждён (confirmed)')
  assert(prac.includes('confirmed ? (') && prac.includes('<div key={c.letter} className={cls}>{body}</div>'),
    'после подтверждения вариант рисуется <div>, а не кнопкой — иначе отметка слова внутри не сработает')
  assert(prac.includes('onClick={() => setPicked(c.letter)}'),
    'до подтверждения вариант остаётся кнопкой выбора без клика по отдельным словам')
  assert(prac.includes('mc-static'), 'отвеченный вариант помечен классом mc-static (правит поведение в styles.css)')
  group('структурно: до ответа разметка есть только в условии, вариант выбирается кнопкой целиком')
}

function main(): void {
  console.log('SRS практика — экран: разбор условия, отсутствующий разбор, очередь и порядок вариантов')
  stemChecks()
  rationaleChecks()
  screenChecks()
  console.log(`\nВсе проверки экрана практики пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ ЭКРАНА ПРАКТИКИ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
