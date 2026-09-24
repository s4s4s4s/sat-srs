#!/usr/bin/env node
/**
 * Импорт официального банка вопросов SAT Suite (College Board Question Bank) в колоду.
 *
 * Читает список вопросов раздела (Math или Reading and Writing), тянет деталь каждого
 * (по external_id через API, либо по ibn через раскрытый JSON старых форм) и пишет md-файлы
 * в `<deck>/Учёба/Вопросы` СТРОГО в формате, который понимает src/lib/practice.ts
 * (parseQuestionBody/questionView) и src/lib/yamlfm.ts (parseMd, CORE_SCHEMA).
 *
 * Сеть из этой среды к collegeboard.org закрыта — живой прогон не проверялся здесь,
 * только фикстурами (test/qbank-import.test.ts). Каждая сетевая неожиданность (незнакомая
 * форма ответа, отсутствующий external_id/ibn, обрыв запроса) уходит в пропуск со своей
 * причиной, а не роняет весь прогон — банк тянут разово, и частичный результат полезнее
 * упавшего процесса на середине тысяч вопросов.
 *
 * Запуск:
 *   node scripts/qbank-import.mjs --deck "D:/dev/sat-deck" --test math
 *   node scripts/qbank-import.mjs --deck "D:/dev/sat-deck" --test all --limit 20
 *   node scripts/qbank-import.mjs --dry-run --test math          # без --deck, ничего не пишет
 *   node scripts/qbank-import.mjs --deck "D:/dev/sat-deck" --from-cache   # без сети
 *
 * Повторный запуск не ходит в сеть за уже скачанным сырьём (--cache, по умолчанию
 * .qbank-cache/ рядом со скриптом — файл на вопрос) и не трогает вопросы, для которых
 * в каталоге уже есть файл с тем же questionId (там могут быть отметки в журнале ученика).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const LIST_URL = 'https://qbank-api.collegeboard.org/msreportingquestionbank-prod/questionbank/digital/get-questions'
const DETAIL_URL = 'https://qbank-api.collegeboard.org/msreportingquestionbank-prod/questionbank/digital/get-question'
const DISCLOSED_URL = (ibn) => `https://saic.collegeboard.org/disclosed/${ibn}.json`

const CONCURRENCY = 6
const RETRIES = 3
const RETRY_PAUSE_MS = 800

/* Раздел экзамена → { test-код списка, домены, ярлык для fm.test } — контракт из открытых
 * источников API банка (см. заголовок задачи): test 2 = Math (домены H,P,Q,S), test 1 =
 * Reading and Writing (INI,CAS,EOI,SEC). */
export const SECTIONS = {
  math: { test: 2, domain: 'H,P,Q,S', label: 'Math' },
  rw: { test: 1, domain: 'INI,CAS,EOI,SEC', label: 'Reading and Writing' }
}

const DIFF_LABEL = { E: 'Easy', M: 'Medium', H: 'Hard' }

/* ------------------------------------------------------------------------ */
/* Чистые функции — экспортируются и покрываются test/qbank-import.test.ts   */
/* ------------------------------------------------------------------------ */

/** Ярлык сложности из кода банка (E|M|H) → Easy|Medium|Hard; незнакомый код возвращается как есть. */
export function difficultyLabel(code) {
  const c = String(code ?? '').trim().toUpperCase()
  return DIFF_LABEL[c] ?? c
}

/** Имя файла вопроса без каталога: slug(skill)-<easy|medium|hard>-<questionId>.md */
export function slugify(s) {
  const base = String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'skill'
}

export function filenameFor(skill, difficultyCode, questionId) {
  const diff = difficultyLabel(difficultyCode).toLowerCase()
  return `${slugify(skill)}-${diff || 'unknown'}-${questionId}.md`
}

/**
 * Вопрос уже есть в каталоге: имя файла оканчивается на `-<questionId>.md` — не важно, какой
 * скилл/сложность стоят перед ним (их мог поменять банк, а файл переименовывать нельзя: в нём
 * могут быть отметки ученика из журнала, привязанные к пути).
 */
export function questionFileExists(dir, questionId) {
  if (!existsSync(dir)) return false
  const suffix = `-${questionId}.md`
  return readdirSync(dir).some(f => f.endsWith(suffix))
}

/** MathML: `<mfenced open close separators>` не рисуется MathML Core → разворачиваем в `<mrow>`
 * с явными `<mo>`. Вложенные mfenced обрабатываются от самых внутренних наружу: регулярное
 * выражение находит mfenced, чьё содержимое не пересекает вложенный `<mfenced`, то есть самый
 * внутренний из оставшихся, заменяет его на mrow и повторяет, пока такие есть. */
export function mfencedToMrow(html) {
  const s = String(html ?? '')
  if (!s.includes('<mfenced')) return s
  const innermostRe = /<mfenced\b([^>]*)>((?:(?!<mfenced\b)[\s\S])*?)<\/mfenced>/
  let result = s
  let guard = 0
  while (innermostRe.test(result) && guard < 2000) {
    guard++
    result = result.replace(innermostRe, (_full, attrsStr, content) => {
      const { open, close, separators } = mfencedAttrs(attrsStr)
      const children = splitTopLevelTags(content)
      return buildFencedMrow(children, open, close, separators)
    })
  }
  return result
}

function mfencedAttrs(attrsStr) {
  const get = (name, def) => {
    const m = String(attrsStr ?? '').match(new RegExp(`${name}="([^"]*)"`))
    return m ? m[1] : def
  }
  return { open: get('open', '('), close: get('close', ')'), separators: get('separators', ',') }
}

function escapeMo(ch) {
  return String(ch).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Top-level (глубина 0) дочерние элементы содержимого mfenced — для расстановки разделителей
 * между ними. Текст вне тегов на глубине 0 (редкость в MathML, но встречается) — тоже child. */
function splitTopLevelTags(content) {
  const children = []
  let depth = 0
  let start = 0
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g
  let m
  while ((m = tagRe.exec(content))) {
    const closing = m[1] === '/'
    const selfClose = m[4] === '/'
    if (closing) {
      depth--
      if (depth === 0) {
        children.push(content.slice(start, tagRe.lastIndex))
        start = tagRe.lastIndex
      }
    } else if (selfClose) {
      if (depth === 0) {
        children.push(content.slice(start, tagRe.lastIndex))
        start = tagRe.lastIndex
      }
    } else {
      depth++
    }
  }
  const trailing = content.slice(start)
  if (trailing.trim()) children.push(trailing)
  return children.filter(c => c.trim() !== '')
}

function buildFencedMrow(children, open, close, separators) {
  const parts = []
  if (open !== '') parts.push(`<mo>${escapeMo(open)}</mo>`)
  children.forEach((child, i) => {
    parts.push(child)
    if (i < children.length - 1) {
      const sep = separators.length ? separators[Math.min(i, separators.length - 1)] : ''
      if (sep) parts.push(`<mo>${escapeMo(sep)}</mo>`)
    }
  })
  if (close !== '') parts.push(`<mo>${escapeMo(close)}</mo>`)
  return `<mrow>${parts.join('')}</mrow>`
}

/** Если весь фрагмент — один внешний `<p>…</p>`, снимаем его (варианты ответа банка часто
 * приходят обёрнутыми в один параграф; лишний `<p>` вокруг однострочного варианта не нужен). */
export function stripOuterP(html) {
  const s = String(html ?? '').trim()
  const openMatch = s.match(/^<p\b[^>]*>/i)
  if (!openMatch || !/<\/p>$/i.test(s)) return s
  const inner = s.slice(openMatch[0].length, s.length - '</p>'.length)
  // ещё один <p>/</p> внутри — значит внешний тег не единственный (несколько параграфов),
  // снимать нечего: greedy/non-greedy regex тут одинаково даёт ложное совпадение по $-якорю
  if (/<\/?p\b/i.test(inner)) return s
  return inner.trim()
}

/** HTML-фрагмент → одна строка (требование формата файла): переводы строк на пробелы,
 * повторные пробелы схлопнуты. Если результат начинает строку с "## " (сама эта
 * последовательность внутри условия/варианта/разбора — редкость, но `## Вопрос` и т.п.
 * разбираются parseQuestionBody по этому маркеру), добавляем безвредный HTML-комментарий
 * впереди, чтобы строка не выглядела заголовком раздела. */
export function oneLine(html) {
  let s = String(html ?? '').replace(/\r\n|\r|\n/g, ' ').replace(/[ \t]+/g, ' ').trim()
  if (s.startsWith('##')) s = `<!-- -->${s}`
  return s
}

/**
 * Нормализованный ответ get-question (API банка) → { kind, stimulus, stem, choices, answer,
 * answers, rationale } либо { unknownSchema: true, raw } на незнакомую форму.
 *
 * mcq: answerOptions — массив {id, content}; порядок в массиве даёт буквы A..D (id не
 * гарантированно буквенный), correct_answer[0] сопоставляется по id с одним из вариантов.
 * spr: correct_answer — список принятых текстовых форм ответа.
 */
export function parseApiQuestion(json) {
  if (!json || typeof json !== 'object') return { unknownSchema: true, raw: json }
  const stimulus = typeof json.stimulus === 'string' ? json.stimulus : ''
  const stem = typeof json.stem === 'string' ? json.stem : ''
  const rationale = typeof json.rationale === 'string' ? json.rationale : ''
  const type = String(json.type ?? '').toLowerCase()

  if (type === 'mcq') {
    const opts = Array.isArray(json.answerOptions) ? json.answerOptions : []
    if (opts.length !== 4) return { unknownSchema: true, raw: json }
    const letters = ['A', 'B', 'C', 'D']
    const choices = opts.map((o, i) => ({ letter: letters[i], html: String(o?.content ?? '') }))
    const correctId = Array.isArray(json.correct_answer) ? json.correct_answer[0] : undefined
    const idx = opts.findIndex(o => o?.id === correctId)
    const answer = idx >= 0 ? letters[idx] : ''
    return { kind: 'mcq', stimulus, stem, choices, answer, answers: [], rationale }
  }
  if (type === 'spr') {
    const raw = Array.isArray(json.correct_answer) ? json.correct_answer : []
    const answers = raw.map(a => String(a).trim()).filter(Boolean)
    return { kind: 'spr', stimulus, stem, choices: [], answer: '', answers, rationale }
  }
  return { unknownSchema: true, raw: json }
}

/**
 * Нормализованный ответ disclosed JSON (старые раскрытые задания, по ibn) → та же форма, что
 * parseApiQuestion, либо { unknownSchema: true, raw }.
 *
 * mcq: ровно 4 варианта choices.a..d и correct_choice в a..d. Иначе — ищем строковое поле
 * ответа среди правдоподобных имён (схема SPR у disclosed не задокументирована публично,
 * поэтому перебор нескольких кандидатов — осознанный компромисс, а не догадка вслепую) и,
 * если оно есть, разбиваем по запятой на принятые формы (spr). Не нашли ни то, ни другое —
 * unknown-schema с сохранением сырья, вопрос не теряется молча.
 */
export function parseDisclosedQuestion(rawArray) {
  const item = Array.isArray(rawArray) ? rawArray[0] : rawArray
  if (!item || typeof item !== 'object') return { unknownSchema: true, raw: rawArray }
  const answer = item.answer && typeof item.answer === 'object' ? item.answer : {}
  const stimulus = typeof item.prompt === 'string' ? item.prompt : ''
  const stem = typeof item.body === 'string' ? item.body : ''
  const rationale = typeof answer.rationale === 'string' ? answer.rationale : ''

  const choices = answer.choices && typeof answer.choices === 'object' ? answer.choices : null
  const correctChoice = typeof answer.correct_choice === 'string' ? answer.correct_choice.trim().toLowerCase() : ''
  const letterKeys = ['a', 'b', 'c', 'd']
  const isMcq = !!choices && letterKeys.every(k => choices[k] && typeof choices[k] === 'object')
    && letterKeys.includes(correctChoice)
  if (isMcq) {
    const LETTERS = ['A', 'B', 'C', 'D']
    const mcqChoices = letterKeys.map((k, i) => ({ letter: LETTERS[i], html: String(choices[k].body ?? '') }))
    return { kind: 'mcq', stimulus, stem, choices: mcqChoices, answer: LETTERS[letterKeys.indexOf(correctChoice)], answers: [], rationale }
  }

  const sprCandidates = ['correct_answer', 'value', 'text', 'answer_value', 'spr_answer', 'rcc']
  let sprRaw = ''
  for (const key of sprCandidates) {
    if (typeof answer[key] === 'string' && answer[key].trim()) { sprRaw = answer[key]; break }
  }
  if (sprRaw) {
    const answers = sprRaw.split(',').map(a => a.trim()).filter(Boolean)
    if (answers.length) return { kind: 'spr', stimulus, stem, choices: [], answer: '', answers, rationale }
  }
  return { unknownSchema: true, raw: rawArray }
}

/**
 * Метаданные вопроса → md-файл в формате практики (src/lib/practice.ts/yamlfm.ts).
 * `q` — нормализованный вопрос (parseApiQuestion/parseDisclosedQuestion, kind mcq|spr,
 * unknownSchema=false). Frontmatter пишется вручную (JSON.stringify — валидное double-quoted
 * YAML под CORE_SCHEMA, без зависимости от js-yaml, которую скрипт намеренно не тянет).
 */
export function buildQuestionMarkdown(meta, q) {
  const fmLines = []
  const put = (k, v) => fmLines.push(`${k}: ${JSON.stringify(v)}`)
  put('qid', meta.qid)
  put('assessment', 'SAT')
  put('test', meta.testLabel)
  put('domain', meta.domain)
  put('skill', meta.skill)
  put('difficulty', difficultyLabel(meta.difficultyCode))
  put('format', 'html')
  put('added', meta.added)
  if (q.kind === 'mcq') {
    put('answer', q.answer)
  } else {
    put('answer_type', 'spr')
    fmLines.push(`answers: [${q.answers.map(a => JSON.stringify(a)).join(', ')}]`)
  }
  const front = `---\n${fmLines.join('\n')}\n---\n`

  const body = []
  body.push('## Вопрос')
  body.push('')
  if (q.stimulus && q.stimulus.trim()) { body.push(oneLine(q.stimulus)); body.push('') }
  body.push(oneLine(q.stem))

  if (q.kind === 'mcq') {
    body.push('')
    body.push('## Варианты')
    body.push('')
    q.choices.forEach((c, i) => {
      body.push(`${c.letter}. ${oneLine(stripOuterP(c.html))}`)
      if (i < q.choices.length - 1) body.push('')
    })
  }

  if (q.rationale && q.rationale.trim()) {
    body.push('')
    body.push('## Разбор')
    body.push('')
    body.push(oneLine(q.rationale))
  }

  return `${front}\n${body.join('\n')}\n`
}

/** Сегодня в ГГГГ-ММ-ДД (локальная дата машины, как `added` у карточек/текстов). */
export function todayKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * `<img src="http…">` → data:URI (base64) через инжектируемый fetcher (упрощает тест без сети).
 * fetcher(url) обязан вернуть { contentType, base64 } или бросить/резолвиться с ошибкой —
 * неудача не трогает src (картинка останется по прежней ссылке), относительный src не трогаем
 * вовсе и считаем отдельно (repoting наружу через counts).
 */
export async function embedImages(html, fetcher) {
  const s = String(html ?? '')
  const imgRe = /<img\b[^>]*?\bsrc="([^"]*)"[^>]*>/g
  const seen = new Map() // src -> dataUri | null (null = не удалось)
  let m
  const srcs = []
  while ((m = imgRe.exec(s))) srcs.push(m[1])
  let embedded = 0, failed = 0, relative = 0
  for (const src of srcs) {
    if (seen.has(src)) continue
    if (!/^https?:\/\//i.test(src)) { relative++; seen.set(src, null); continue }
    try {
      const { contentType, base64 } = await fetcher(src)
      seen.set(src, `data:${contentType};base64,${base64}`)
      embedded++
    } catch {
      seen.set(src, null)
      failed++
    }
  }
  let result = s
  for (const [src, dataUri] of seen) {
    if (dataUri) result = result.split(`"${src}"`).join(`"${dataUri}"`)
  }
  return { html: result, embedded, failed, relative }
}

/* ------------------------------------------------------------------------ */
/* Сеть, кэш, CLI — не покрывается юнит-тестами (нет доступа к collegeboard.org  */
/* из этой среды); написано защитно, каждая сетевая неожиданность — в отчёт.    */
/* ------------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { test: 'math', cache: join(__dirname, '..', '.qbank-cache'), limit: Infinity }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--deck') args.deck = argv[++i]
    else if (a === '--test') args.test = argv[++i]
    else if (a === '--cache') args.cache = argv[++i]
    else if (a === '--limit') args.limit = Number(argv[++i])
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--from-cache') args.fromCache = true
  }
  return args
}

function cachePathFor(cacheDir, kind, key) {
  const safeKey = String(key).replace(/[^a-zA-Z0-9_.-]/g, '_')
  return join(cacheDir, `${kind}-${safeKey}.json`)
}

async function readCache(path) {
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

function writeCache(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data), 'utf8')
}

async function fetchJsonWithRetry(url, opts, retries = RETRIES) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      if (attempt < retries) await new Promise(r => setTimeout(r, RETRY_PAUSE_MS))
    }
  }
  throw lastErr
}

async function fetchImageAsDataParts(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const contentType = res.headers.get('content-type') || 'application/octet-stream'
  const buf = Buffer.from(await res.arrayBuffer())
  return { contentType, base64: buf.toString('base64') }
}

async function fetchList(section, cacheDir, fromCache) {
  const cachePath = cachePathFor(cacheDir, 'list', section)
  if (fromCache) {
    const cached = await readCache(cachePath)
    if (!cached) throw new Error(`--from-cache: список ${section} не найден в кэше`)
    return cached
  }
  const cached = await readCache(cachePath)
  if (cached) return cached
  const { test, domain } = SECTIONS[section]
  const json = await fetchJsonWithRetry(LIST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ asmtEventId: 99, test, domain })
  })
  const list = Array.isArray(json) ? json : []
  writeCache(cachePath, list)
  return list
}

async function fetchDetail(item, cacheDir, fromCache) {
  const key = item.external_id || item.ibn || item.questionId
  const cachePath = cachePathFor(cacheDir, 'detail', key)
  const cached = await readCache(cachePath)
  if (cached) return cached
  if (fromCache) throw new Error(`--from-cache: деталь ${key} не найдена в кэше`)

  if (item.external_id) {
    const json = await fetchJsonWithRetry(DETAIL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ external_id: item.external_id })
    })
    const wrapped = { source: 'api', json }
    writeCache(cachePath, wrapped)
    return wrapped
  }
  if (item.ibn) {
    const json = await fetchJsonWithRetry(DISCLOSED_URL(item.ibn), {
      method: 'GET',
      headers: { accept: 'application/json' }
    })
    const wrapped = { source: 'disclosed', json }
    writeCache(cachePath, wrapped)
    return wrapped
  }
  throw new Error('нет ни external_id, ни ibn')
}

/** Пул с ограниченной конкурентностью — без внешних зависимостей. */
async function runPool(items, limit, worker) {
  let i = 0
  const results = new Array(items.length)
  async function next() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await worker(items[idx], idx)
    }
  }
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(() => next()))
  return results
}

async function importSection(section, args, summary) {
  const { label, } = SECTIONS[section]
  const list = await fetchList(section, args.cache, args.fromCache)
  const items = list.slice(0, Number.isFinite(args.limit) ? args.limit : list.length)

  const outDir = args.deck ? join(args.deck, 'Учёба', 'Вопросы') : null
  if (outDir && !args.dryRun) mkdirSync(outDir, { recursive: true })

  await runPool(items, CONCURRENCY, async (item) => {
    const qid = item.questionId
    if (!qid) { summary.skip('fetch-error'); return }
    if (outDir && questionFileExists(outDir, qid)) { summary.skip('exists'); return }

    let detail
    try {
      detail = await fetchDetail(item, args.cache, args.fromCache)
    } catch (err) {
      summary.skip('fetch-error', err)
      return
    }

    const norm = detail.source === 'disclosed'
      ? parseDisclosedQuestion(detail.json)
      : parseApiQuestion(detail.json)

    if (norm.unknownSchema) { summary.skip('unknown-schema'); return }
    if (norm.kind === 'mcq' && (!norm.answer || norm.choices.length !== 4)) { summary.skip('no-answer'); return }
    if (norm.kind === 'spr' && !norm.answers.length) { summary.skip('no-answer'); return }

    // картинки: скачать и встроить, неудачу — оставить src и посчитать (не блокирует запись)
    const embed = async (html) => {
      const r = await embedImages(html, fetchImageAsDataParts)
      summary.images(r.embedded, r.failed, r.relative)
      return r.html
    }
    norm.stimulus = await embed(mfencedToMrow(norm.stimulus))
    norm.stem = await embed(mfencedToMrow(norm.stem))
    norm.rationale = await embed(mfencedToMrow(norm.rationale))
    if (norm.kind === 'mcq') {
      for (const c of norm.choices) c.html = await embed(mfencedToMrow(c.html))
    }

    const meta = {
      qid,
      testLabel: label,
      domain: item.primary_class_cd_desc ?? '',
      skill: item.skill_desc ?? '',
      difficultyCode: item.difficulty ?? '',
      added: todayKey()
    }
    const md = buildQuestionMarkdown(meta, norm)

    if (!args.dryRun && outDir) {
      writeFileSync(join(outDir, filenameFor(meta.skill, meta.difficultyCode, qid)), md, 'utf8')
    }
    summary.write(section, meta.difficultyCode, item.primary_class_cd_desc, norm.kind)
  })
}

function makeSummary() {
  const skipReasons = {}
  const domains = {}
  const difficulties = {}
  let written = 0, mcq = 0, spr = 0
  let imagesEmbedded = 0, imagesFailed = 0, imagesRelative = 0
  return {
    skip(reason) { skipReasons[reason] = (skipReasons[reason] || 0) + 1 },
    write(_section, difficultyCode, domain, kind) {
      written++
      const diff = difficultyLabel(difficultyCode)
      difficulties[diff] = (difficulties[diff] || 0) + 1
      domains[domain || '(без домена)'] = (domains[domain || '(без домена)'] || 0) + 1
      if (kind === 'mcq') mcq++; else spr++
    },
    images(e, f, r) { imagesEmbedded += e; imagesFailed += f; imagesRelative += r },
    print() {
      console.log('\n== qbank-import: сводка ==')
      console.log(`записано: ${written} (mcq: ${mcq}, spr: ${spr})`)
      console.log('пропущено:', JSON.stringify(skipReasons))
      console.log('по доменам:', JSON.stringify(domains))
      console.log('по сложности:', JSON.stringify(difficulties))
      console.log(`картинки: встроено ${imagesEmbedded}, не встроено ${imagesFailed}, относительных ${imagesRelative}`)
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.deck && !args.dryRun) {
    console.error('нужен --deck <путь к локальной копии колоды> (или --dry-run)')
    process.exitCode = 1
    return
  }
  const sections = args.test === 'all' ? ['math', 'rw'] : args.test === 'rw' ? ['rw'] : ['math']
  const summary = makeSummary()
  for (const section of sections) {
    await importSection(section, args, summary)
  }
  summary.print()
}

/* Не `resolve(argv[1]) === fileURLToPath(import.meta.url)`: под esbuild (`npm run test:qbank`)
 * этот файл и test/qbank-import.test.ts бандлятся в ОДИН выходной файл, и внутри такого бандла
 * import.meta.url указывает на сам бандл независимо от того, из какого исходника пришёл код —
 * сравнение с фактическим URL модуля было бы всегда истинным и запускало бы main() при каждом
 * прогоне тестов. Поэтому сверяем ИМЯ файла (не путь) со собственным именем скрипта: прямой
 * запуск `node scripts/qbank-import.mjs …` даёт совпадение, а тестовый бандл — нет, потому что
 * его выходной файл в package.json (test:qbank) сознательно назван иначе. */
const SCRIPT_BASENAME = 'qbank-import.mjs'
const isMain = process.argv[1] && basename(process.argv[1]) === SCRIPT_BASENAME
if (isMain) {
  main().catch(err => {
    console.error('qbank-import: ошибка', err)
    process.exitCode = 1
  })
}
