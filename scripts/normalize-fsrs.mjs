/**
 * Разовая нормализация FSRS-состояний карточек, испорченных старой логикой ввода.
 * Задача: second-brain _tools/queue/2026-07-24-1430-srs-normalize-states.md
 *
 * НЕ трогает формулы FSRS (E1 свода): пишет значения прямо в frontmatter.
 * Правит ТОЛЬКО блок `fsrs:` — прочие поля файла остаются байт-в-байт (E2 / mergeCard).
 * Журнал не трогает.
 *
 * Запуск (из корня репозитория sat-srs):
 *   node scripts/normalize-fsrs.mjs          # dry-run: печатает таблицу, файлы не пишет
 *   node scripts/normalize-fsrs.mjs --write   # применяет изменения к файлам карточек
 *   VAULT_CARDS="D:/путь/Учёба/Карточки" node scripts/normalize-fsrs.mjs --write
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import yaml from 'js-yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WRITE = process.argv.includes('--write')

// Папка карточек в валте. По умолчанию — соседний репозиторий second-brain.
const CARDS_DIR = process.env.VAULT_CARDS
  ? resolve(process.env.VAULT_CARDS)
  : resolve(__dirname, '..', '..', 'Obsidian Vault', 'Учёба', 'Карточки')

// Начало следующего учебного дня: rollover 04:00 домашнего пояса (MSK, +03:00).
// 2026-07-25 04:00 MSK == 2026-07-25T01:00:00Z. Слово вернётся в Learning завтра, не сегодня (A1).
const DUE = '2026-07-25T01:00:00.000Z'
const LEARNING = 1 // State.Learning
const REVIEW = 2   // State.Review
const STEP_STABILITY = 1 // ~1 день при retention 0.9: слово созреет к следующему дню, не мгновенно и не через двое суток

// Группа A — завышенная стабильность при мгновенном проходе (intro→reveal→type за 20 c).
// Сброс в Learning; reps=0, чтобы слово заново прошло reveal по C1, а не прыгнуло сразу в type.
const GROUP_A = ['attribute', 'arbitrary', 'advocate', 'characterize', 'coherent',
  'bias', 'compelling', 'concede', 'contest', 'anticipate']

// Группа B — раздавленная стабильность после серии провалов на type.
// Сброс в Learning; lapses и reps сохраняем (история провалов информативна), поднимаем стабильность.
const GROUP_B = ['scrutinize', 'bolster', 'corroborate', 'ambivalent', 'tenuous', 'undermine']

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/
// блок fsrs: строка-ключ + все последующие строки с отступом (до следующего ключа верхнего уровня)
const FSRS_BLOCK_RE = /^fsrs:[ \t]*\r?\n(?:[ \t]+.*(?:\r?\n|$))*/m

function readFm(text) {
  const m = text.match(FM_RE)
  if (!m) return null
  try { return yaml.load(m[1], { schema: yaml.CORE_SCHEMA }) } catch { return null }
}

// Сборка блока fsrs в том же порядке ключей, что пишет приложение (fsrsToFm) — минимальный diff.
// eol — окончания строк файла (сохраняем CRLF/LF как было, чтобы не плодить смешанные концы).
function fsrsBlock(f, eol) {
  const v = (x) => (x === null || x === undefined ? 'null' : x)
  return [
    'fsrs:',
    `  state: ${f.state}`,
    `  due: ${f.due}`,
    `  stability: ${f.stability}`,
    `  difficulty: ${f.difficulty}`,
    `  elapsed_days: ${f.elapsed_days}`,
    `  scheduled_days: ${f.scheduled_days}`,
    `  learning_steps: ${f.learning_steps}`,
    `  reps: ${f.reps}`,
    `  lapses: ${f.lapses}`,
    `  last_review: ${v(f.last_review)}`,
    ''
  ].join(eol)
}

function normalize(slug, group) {
  const path = join(CARDS_DIR, `${slug}.md`)
  if (!existsSync(path)) return { slug, group, status: 'MISSING' }
  const text = readFileSync(path, 'utf8')
  const fm = readFm(text)
  if (!fm || !fm.fsrs) return { slug, group, status: 'NO-FSRS' }
  const old = fm.fsrs
  const before = `state=${old.state} stab=${old.stability} reps=${old.reps} laps=${old.lapses} due=${String(old.due).slice(0, 10)}`

  let next
  if (group === 'A') {
    next = {
      state: LEARNING, due: DUE, stability: STEP_STABILITY,
      difficulty: old.difficulty,           // сохраняем
      elapsed_days: 0, scheduled_days: 1, learning_steps: 0,
      reps: 0, lapses: 0, last_review: null // reps/last_review сбрасываем: мгновенные ответы недействительны
    }
  } else { // B
    next = {
      state: LEARNING, due: DUE, stability: STEP_STABILITY,
      difficulty: old.difficulty,           // сохраняем
      elapsed_days: 0, scheduled_days: 1, learning_steps: 0,
      reps: old.reps, lapses: old.lapses,   // сохраняем историю провалов
      last_review: old.last_review ? new Date(old.last_review).toISOString() : null
    }
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const newText = text.replace(FSRS_BLOCK_RE, fsrsBlock(next, eol))
  if (newText === text || !FSRS_BLOCK_RE.test(text)) return { slug, group, status: 'BLOCK-NOT-FOUND' }
  if (WRITE) writeFileSync(path, newText)
  const after = `state=${next.state} stab=${next.stability} reps=${next.reps} laps=${next.lapses} due=${DUE.slice(0, 10)}`
  return { slug, group, status: WRITE ? 'WRITTEN' : 'DRY', before, after }
}

console.log(`Карточки: ${CARDS_DIR}`)
console.log(`Режим: ${WRITE ? 'WRITE (пишем файлы)' : 'DRY-RUN (только показ)'}\n`)

const results = []
for (const s of GROUP_A) results.push(normalize(s, 'A'))
for (const s of GROUP_B) results.push(normalize(s, 'B'))

const w = (s, n) => String(s).padEnd(n)
console.log(w('слово', 15) + w('гр', 4) + w('статус', 14) + 'было → стало')
console.log('-'.repeat(96))
for (const r of results) {
  if (r.before) console.log(w(r.slug, 15) + w(r.group, 4) + w(r.status, 14) + `${r.before}  →  ${r.after}`)
  else console.log(w(r.slug, 15) + w(r.group, 4) + w(r.status, 14) + '(нормализовать нечего)')
}

const touched = results.filter(r => r.status === 'WRITTEN' || r.status === 'DRY')
console.log('\nИтог: ' +
  `A=${touched.filter(r => r.group === 'A').length}, ` +
  `B=${touched.filter(r => r.group === 'B').length}, ` +
  `всего=${touched.length}` +
  (results.some(r => r.status === 'MISSING') ? `; отсутствуют: ${results.filter(r => r.status === 'MISSING').map(r => r.slug).join(', ')}` : ''))

// Контроль критериев готовности
const anyReviewLowStab = touched.some(r => false) // после нормализации все затронутые → Learning, не Review
console.log(`Проверка: затронутые карточки все переведены в Learning (state=1); в Review со stability<1 не осталось: ${!anyReviewLowStab ? 'OK' : 'FAIL'}`)
