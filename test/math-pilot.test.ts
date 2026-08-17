/**
 * Проверка пилотных math-карточек (задача 22.08.2026 — разбор математики пробника).
 *
 * До этой пачки в живой колоде не было ни одной карточки kind: math — весь путь
 * (частичный разбор YAML, рендер формул KaTeX, сверка числового ответа, роутинг
 * в отдельный раздел) ни разу не исполнялся на настоящих данных. Этот файл гоняет
 * РЕАЛЬНЫЙ код приложения (src/lib/yamlfm.ts parseMd/cardView, src/lib/scheduler.ts
 * checkNumeric/parseNum/pickTask/sectionOf) на четырёх новых файлах из
 * Учёба/Карточки/math-*.md — а не на синтетических объектах.
 *
 * Подключён третьим шагом `npm test` → `npm run test:math`. Фикстуры — копии
 * реальных пилотных карточек, лежат В РЕПОЗИТОРИИ (test/fixtures/math), а не в
 * вальте: путь к вальту существует только на этой машине, на сборке его нет.
 * Запуск: npm run test:math (или напрямую — см. package.json, скрипт test:math)
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { strict as assert } from 'node:assert'
import katex from 'katex'
import { State } from 'ts-fsrs'
import type { CardRec, StudyItem } from '../src/lib/types'
import { parseMd, cardView } from '../src/lib/yamlfm'
import { checkNumeric, parseNum, pickTask, sectionOf, slowThresholdMs } from '../src/lib/scheduler'
import { cardTimeCap } from '../src/lib/journal'

/**
 * Путь к фикстурам строим от cwd, а не от import.meta.url этого модуля.
 * Причина: npm run test:math бандлит этот файл esbuild-ом в один файл в
 * node_modules/.cache/sat-srs/ (тот же приём, что test:session/test:metrics) и
 * запускает его оттуда — import.meta.url внутри бандла указывал бы на кэш, а не
 * на исходники, и «путь от файла теста» вёл бы в никуда после первой же смены
 * --outfile в package.json. npm гарантированно запускает скрипты из package.json
 * с cwd = корень пакета — на этом уже держится соседний --outfile=node_modules/...
 * в тех же двух скриптах, так что это не новое допущение, а то же самое явно.
 */
const DECK_DIR = path.join(process.cwd(), 'test', 'fixtures', 'math')
const FILES = [
  'math-alg-substitution.md',      // MC-сетап: формула в вопросе И в вариантах
  'math-psda-ratio-fraction.md',   // числовой ответ: дробь ⇄ десятичная
  'math-am-quadratic-desmos.md',   // MC-сетап с бейджем Desmos
  'math-alg-linear-decimal.md'     // числовой ответ: десятичная, включая ввод через запятую
]

let passed = 0
function ok(cond: boolean, msg: string): void {
  assert.ok(cond, msg)
  passed++
}

/** Извлечение $...$ — та же регулярка, что splitTex в src/components/Tex.tsx (не экспортирована). */
function texFragments(s: string): string[] {
  const out: string[] = []
  const re = /\$([^$]+)\$/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(m[1])
  return out
}

function loadCard(file: string): { rec: CardRec; view: ReturnType<typeof cardView> } {
  const text = readFileSync(path.join(DECK_DIR, file), 'utf8')
  const { fm, body, broken } = parseMd(text)
  ok(!broken, `${file}: YAML не разобрался (broken=1) — карточка молча мертва`)
  const rec: CardRec = { path: `Учёба/Карточки/${file}`, sha: null, fm, body, dirty: 0, broken }
  const view = cardView(rec)
  return { rec, view }
}

function main(): void {
  const cards = FILES.map(loadCard)

  // ---- 1. Парсинг: поля дошли до CardView такими, как задуманы --------------
  const [subst, ratio, quad, linear] = cards.map(c => c.view)

  ok(subst.kind === 'math' && subst.domain === 'ALG', 'math-alg-substitution: kind/domain')
  ok(subst.choices.length === 4 && subst.choices.includes(subst.answerText),
    'math-alg-substitution: answer совпадает с одним из choices посимвольно (как в CardView, не только в сыром YAML)')
  ok(subst.answerNum === '', 'math-alg-substitution: MC-карточка не должна иметь answerNum')
  ok(subst.level === 999, 'math-alg-substitution: level не задан → уходит в хвост (999), не считается словарной')

  ok(ratio.kind === 'math' && ratio.domain === 'PSDA', 'math-psda-ratio-fraction: kind/domain')
  ok(ratio.answerNum === '3/8', `math-psda-ratio-fraction: answerNum дошёл как есть, получено «${ratio.answerNum}»`)
  ok(ratio.choices.length === 0, 'math-psda-ratio-fraction: числовая карточка не должна иметь choices')

  ok(quad.desmos === true, 'math-am-quadratic-desmos: desmos=true дошёл до CardView')
  ok(quad.domain === 'AM', 'math-am-quadratic-desmos: domain=AM')

  ok(linear.answerNum === '4.5', `math-alg-linear-decimal: answerNum как строка «4.5», получено «${linear.answerNum}»`)
  console.log('  ✓ парсинг: 4/4 карточки разобраны, поля дошли до CardView без потерь')

  // ---- 2. Формулы: каждый фрагмент $...$ — валидный KaTeX -------------------
  let texChecked = 0
  for (const { view } of cards) {
    const fields = [view.context, view.explain, ...view.choices]
    for (const f of fields) {
      for (const frag of texFragments(f)) {
        texChecked++
        assert.doesNotThrow(() => katex.renderToString(frag, { throwOnError: true, output: 'html' }),
          `формула «$${frag}$» не рендерится KaTeX (карточка ${view.word})`)
      }
    }
  }
  ok(texChecked >= 6, `формул с $...$ найдено и провалидировано: ${texChecked} (ожидалось ≥ 6 — по вопросам и вариантам)`)
  console.log(`  ✓ KaTeX: ${texChecked} формул(ы) рендерятся без ошибок`)

  // ---- 3. Числовой ответ: эквивалентные формы (контракт: 0.8 = 4/5 = .8) ----
  const fractionCases: [string, string, boolean][] = [
    ['3/8', '3/8', true],       // точное совпадение
    ['3/8', '0.375', true],     // дробь ⇄ десятичная
    ['3/8', '.375', true],      // без ведущего нуля
    ['3/8', '6/16', true],      // несокращённая эквивалентная дробь
    ['3/8', '0,375', true],     // запятая как разделитель (русская клавиатура)
    ['3/8', '0.4', false],      // неверный ответ
    ['3/8', '3/9', false]       // похожая, но неверная дробь
  ]
  for (const [answer, typed, expectCorrect] of fractionCases) {
    const verdict = checkNumeric(typed, answer)
    ok((verdict === 'correct') === expectCorrect,
      `checkNumeric(«${typed}», answer=«${answer}») = ${verdict}, ожидался ${expectCorrect ? 'correct' : 'не correct'}`)
  }
  console.log('  ✓ checkNumeric: дробь/десятичная/запятая — все 7 случаев дали верный вердикт')

  const decimalCases: [string, string, boolean][] = [
    ['4.5', '4.5', true],
    ['4.5', '4,5', true],       // запятая — то же число
    ['4.5', '9/2', true],       // эквивалентная дробь
    ['4.5', '4.500000', true],  // допуск на хвостовые нули
    ['4.5', '5', false],
    ['4.5', '-4.5', false],
    ['4.5', 'сорок пять', false] // нечисловой ввод — не путается с текстовым сравнением
  ]
  for (const [answer, typed, expectCorrect] of decimalCases) {
    const verdict = checkNumeric(typed, answer)
    ok((verdict === 'correct') === expectCorrect,
      `checkNumeric(«${typed}», answer=«${answer}») = ${verdict}, ожидался ${expectCorrect ? 'correct' : 'не correct'}`)
  }
  console.log('  ✓ checkNumeric: 4.5 против запятой/дроби/мусора — все 7 случаев дали верный вердикт')

  ok(parseNum('3/0') === null, 'parseNum: деление на ноль не должно давать число')
  ok(parseNum('') === null, 'parseNum: пустая строка — null, а не 0')
  console.log('  ✓ parseNum: край-кейсы (деление на 0, пустой ввод) не проходят как число')

  // ---- 4. Роутинг: math не смешивается со словарём/грамматикой --------------
  for (const { view } of cards) {
    ok(sectionOf(view) === 'math', `sectionOf(${view.word}) = ${sectionOf(view)}, ожидался 'math' (domain=${view.domain}, kind=${view.kind})`)
  }
  console.log('  ✓ sectionOf: все 4 карточки (ALG/PSDA/AM) идут в раздел «математика», не в rw/grammar')

  // ---- 5. Формат: math не проходит через intro/ротацию, выдаётся сразу ------
  // Карточки только что созданы (нет fsrs-блока) → cardView даёт state=New по умолчанию.
  for (const { view } of cards) {
    ok(view.fsrs.state === State.New, `${view.word}: ожидалось состояние New у свежесозданной карточки`)
    const item: StudyItem = { view, skill: 'recall', fsrs: view.fsrs }
    const { format } = pickTask(item, [view], undefined, undefined, true, false)
    const expected = view.choices.length >= 2 ? 'mc' : 'type'
    ok(format === expected,
      `pickTask(${view.word}, state=New) = ${format}, ожидался ${expected} — math обязан миновать intro/ротацию даже на первом показе`)
  }
  console.log('  ✓ pickTask: math выдаётся как mc/type сразу, минуя intro и REVIEW_CYCLE, даже для только что созданных карточек')

  // ---- 6. Тайминг: math-специфичные пороги подключены по kind ---------------
  ok(slowThresholdMs('math') === 90_000, 'slowThresholdMs(math) должен быть 90с (контракт: math решается дольше слова)')
  ok(cardTimeCap('math') === 180_000, 'cardTimeCap(math) должен быть 180с (AFK-кап втрое шире словарного)')
  for (const { view } of cards) {
    ok(slowThresholdMs(view.kind) === 90_000, `${view.word}: slowThresholdMs по kind из файла даёт 90с`)
  }
  console.log('  ✓ тайминг: 90с порог «медленно» и 180с AFK-кап подключены по kind, дошедшему из frontmatter')

  console.log(`\nВсе проверки пройдены (${passed} утверждений).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
