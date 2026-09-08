/**
 * Структурная проверка стилей: их нельзя прогнать в jsdom без браузерной раскладки, поэтому
 * читаем src/styles.css текстом и ищем нужные правила, как screenSource читает исходник экрана.
 *
 * F69: `.s-stats { column-count: 2 }` раскладывал контейнер по ЗАДАННОЙ высоте (`.screen`
 * растянут флексом), и контент, не уместившийся в неё, уезжал в невидимую третью колонку за
 * правым краем, обрезанную overflow-x - последняя карточка статистики исчезала целиком на
 * ширинах ноутбука. Правило column-count/columns на этом контейнере запрещено навсегда.
 *
 * Запуск: `npm run test:styles` (esbuild бандлит файл и node его исполняет).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

function stylesSource(): string {
  const p = path.join(process.cwd(), 'src', 'styles.css')
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

/** Вырезает тело первого правила `.s-stats { ... }` (без вложенных медиа-блоков и других селекторов). */
function sStatsRuleBody(css: string): string {
  const m = css.match(/\.s-stats\s*\{([^}]*)\}/)
  assert(!!m, 'в styles.css должно быть правило .s-stats { ... }')
  return m![1]
}

function statsLayoutChecks(): void {
  const css = stylesSource()
  const body = sStatsRuleBody(css)
  assert(!/column-count/.test(body), 'F69: .s-stats не должен раскладываться column-count (карточка спрятана лишней колонкой)')
  assert(!/(?<![\w-])columns\s*:/.test(body), 'F69: .s-stats не должен использовать сокращённое свойство columns')
  assert(/display\s*:\s*grid/.test(body), '.s-stats раскладывается сеткой без column-count')
  group('F69: контейнер .s-stats без column-count/columns, раскладка сеткой')
}

/** Тело правила `.s-home { ... }` внутри десктопного медиа-блока (первое вхождение). */
function sHomeRuleBody(css: string): string {
  const m = css.match(/\.s-home\s*\{([^}]*)\}/)
  assert(!!m, 'в styles.css должно быть правило .s-home { ... }')
  return m![1]
}

/**
 * Главный на ноутбуке. `.screen` растянут флексом на высоту окна, и сетка `.s-home` с
 * auto-рядами, не влезая в окно, ужимала ряды карточек разделов до доли содержимого:
 * у `.section-card` overflow: hidden, минимальной высоты нет, кнопка «Учить» уходила под
 * нижний край (ширина 1238 px, шесть разделов и путь слов). Ряды обязаны считаться по
 * содержимому. Приоритет дня (`.today-btn`, `.today-reason`) занимает полную строку сетки,
 * иначе он встаёт по одной ячейке среди карточек.
 */
function homeGridChecks(): void {
  const css = stylesSource()
  const body = sHomeRuleBody(css)
  assert(/display\s*:\s*grid/.test(body), '.s-home раскладывается сеткой')
  assert(/grid-auto-rows\s*:\s*max-content/.test(body), '.s-home: ряды по содержимому (grid-auto-rows: max-content), иначе кнопки разделов режутся высотой окна')
  for (const cls of ['today-btn', 'today-reason']) {
    const rule = css.match(new RegExp(`\\.s-home\\s*>\\s*\\.${cls}\\s*\\{([^}]*)\\}`))
    assert(!!rule, `.s-home > .${cls} должен иметь своё правило в десктопном блоке`)
    assert(/grid-column\s*:\s*1\s*\/\s*-1/.test(rule![1]), `.s-home > .${cls} занимает полную строку сетки (grid-column: 1 / -1)`)
  }
  group('главный на ноутбуке: ряды сетки по содержимому, приоритет дня на полную строку')
}

statsLayoutChecks()
homeGridChecks()
console.log(`\n${passed} групп проверок styles пройдено`)
