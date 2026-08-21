/**
 * Разметка текста под касание: границы предложений, слова как цели для тапа, поиск сноски,
 * порядок текстов и текущая ступень чтения.
 *
 * Всё здесь — чистые функции над строками и видами (`ReadingView`), без React и без базы:
 * ими живут два экрана (чтение и упражнение), и логика разбиения не должна лежать в том,
 * кто её рисует. Слой данных чтения (journal.ts, yamlfm.ts, store.ts) не дублируется —
 * состояние отметок собирает `activeMarks`, ключ отметки считает `normWord`.
 */
import { activeMarks, normWord } from './journal'
import type { GlossEntry, JournalLine, ReadingView } from './types'

/* ---- границы предложений -------------------------------------------------- */

/**
 * Сокращения, после которых точка предложение НЕ заканчивает.
 *
 * Правило разбиения задано контрактом колоды (`Учёба/Карточки/_КОНТРАКТ.md`, раздел
 * «Чтение»): «`.!?` + пробел + заглавная». В самих текстах для чтения сокращений с точкой
 * быть не должно — их держит ошибкой машинная проверка `tools/чтение-проверка.mjs`. Но тем
 * же разбиением приложение режет КОНТЕКСТ КАРТОЧКИ в упражнении, а контексты этой проверкой
 * не проходят и «Dr.» с «U.S.» в них законны. Поэтому список живёт и здесь — не как копия
 * ради копии, а потому что у приложения источник предложений шире, чем у валидатора колоды.
 * Состав списка намеренно тот же, что в `СОКРАЩЕНИЯ` валидатора: расходиться им незачем.
 *
 * Список фиксирован, а не выведен эвристикой «короткое слово с точкой»: эвристика ловит
 * обычные слова и всё равно не знает сокращений нового домена. Инициалы и буквенные
 * аббревиатуры (`U.S.`, `J. R. R.`) списком не описываются — их ловит отдельное правило
 * односимвольного хвоста в `endsWithAbbreviation`.
 */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'al', 'p', 'pp', 'vol', 'ed',
  'dr', 'mr', 'mrs', 'ms', 'prof', 'jr', 'sr', 'st', 'ave', 'blvd',
  'rd', 'inc', 'corp', 'ltd', 'co', 'fig', 'no'
])

/** Заканчивается ли точка в позиции `dot` сокращением, а не предложением. */
function endsWithAbbreviation(text: string, dot: number): boolean {
  let i = dot
  while (i > 0 && /[A-Za-z.]/.test(text[i - 1])) i--
  const run = text.slice(i, dot)
  if (!run) return false
  const parts = run.split('.')
  // односимвольный хвост — инициал или буква аббревиатуры: «the U.S. Senate», «J. R. R. Tolkien»
  if (parts[parts.length - 1].length === 1) return true
  return ABBREVIATIONS.has(run.toLowerCase())
}

interface Range { start: number; end: number }

/**
 * Границы предложений как отрезки исходной строки (без потери единого символа: пробел между
 * предложениями достаётся следующему и снимается trim-ом). Отрезки нужны разметке — она
 * обязана вернуть текст ровно таким, каким он пришёл, и знать при этом, в каком предложении
 * стоит каждое слово.
 */
function sentenceRanges(text: string): Range[] {
  const out: Range[] = []
  const re = /[.!?]\s+(?=[A-Z])/g
  let start = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (text[m.index] === '.' && endsWithAbbreviation(text, m.index)) continue
    const end = m.index + 1
    out.push({ start, end })
    start = end
  }
  out.push({ start, end: text.length })
  return out
}

/** Предложения строки по правилу контракта. Пустые не возвращаются. */
export function splitSentences(text: string): string[] {
  return sentenceRanges(text).map(r => text.slice(r.start, r.end).trim()).filter(Boolean)
}

/** Абзацы тела текста: пустая строка разделяет, одиночный перенос внутри абзаца — обычный пробел. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map(p => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
}

/* ---- разметка на слова ---------------------------------------------------- */

/**
 * Кусок размеченного текста. `word` — цель для касания; `plain` — пробелы и пунктуация;
 * `tex` — формула `$…$` (в упражнении её рендерит KaTeX, и отмечать в ней нечего);
 * `blank` — пропуск `___` в контексте карточки.
 */
export type Segment =
  | { kind: 'word'; text: string; lemma: string; sentence: string }
  | { kind: 'plain'; text: string }
  | { kind: 'tex'; text: string }
  | { kind: 'blank' }

/* Порядок ветвления важен: формула и пропуск забирают свои символы раньше, чем слово.
   Дефис и апостроф внутри слова не рвут его («well-known», «don't») — тем же правилом
   живёт счёт токенов в валидаторе колоды.

   Точка ВНУТРИ слова его тоже не рвёт: «U.S.» и «e.g.» — одна цель для касания, а не две
   («U» и «S»). Правило узкое намеренно: точка обязана стоять вплотную к следующей букве.
   Точка с пробелом после неё словам не мешает быть разными, поэтому «Dr. Vance» — два слова,
   а «recovered. fishing» в одно не склеивается. */
const TOKEN_RE = /\$[^$]+\$|_{3,}|\p{L}+(?:\.\p{L}+)+\.?|[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu

/**
 * Текст → куски для рендера. Каждое слово несёт предложение, в котором стоит: строка отметки
 * обязана быть самодостаточной (см. `sentence` в JournalLine), а искать предложение в момент
 * касания заново — значит разбирать текст на каждый тап.
 *
 * `blanks` включает распознавание пропуска `___`: он есть у контекста карточки и не имеет
 * смысла в тексте для чтения, где подчёркивания — обычная пунктуация.
 */
export function segmentText(text: string, opts: { blanks?: boolean } = {}): Segment[] {
  const out: Segment[] = []
  const plain = (s: string) => {
    if (!s) return
    const last = out[out.length - 1]
    // соседние обрывки пунктуации склеиваем: лишние узлы дерева не несут ничего
    if (last && last.kind === 'plain') last.text += s
    else out.push({ kind: 'plain', text: s })
  }
  for (const r of sentenceRanges(text)) {
    const slice = text.slice(r.start, r.end)
    const sentence = slice.trim()
    if (!slice) continue
    TOKEN_RE.lastIndex = 0
    let at = 0
    let m: RegExpExecArray | null
    while ((m = TOKEN_RE.exec(slice))) {
      plain(slice.slice(at, m.index))
      at = TOKEN_RE.lastIndex
      const t = m[0]
      if (t.startsWith('$')) { out.push({ kind: 'tex', text: t }); continue }
      if (t.startsWith('_')) { opts.blanks ? out.push({ kind: 'blank' }) : plain(t); continue }
      const lemma = normWord(t)
      // Числа и прочее без букв отметкой стать не могут (markKey отдал бы пустой ключ) —
      // значит и целью для касания быть не должны: тап, который заведомо ничего не делает,
      // хуже отсутствия цели.
      // Одиночная буква — тоже не цель: в английском их всего две («a» и «I»), незнакомыми
      // они не бывают, зато инициалы («J. R. R. Tolkien») дали бы три пустые отметки подряд.
      if (lemma.length >= 2) out.push({ kind: 'word', text: t, lemma, sentence })
      else plain(t)
    }
    plain(slice.slice(at))
  }
  return out
}

/** Леммы слов, отмеченных сейчас в этом источнике (`reading:<слаг>` или `card:<слаг>`). */
export function markedLemmas(lines: JournalLine[], src: string): Set<string> {
  const out = new Set<string>()
  for (const l of activeMarks(lines, src)) {
    const w = normWord(String(l.lemma || l.word || ''))
    if (w) out.add(w)
  }
  return out
}

/* ---- глоссарий ------------------------------------------------------------ */

/**
 * Кандидаты словарной формы для формы из текста: глоссарий пишется леммами («borrow»),
 * а в тексте стоит «borrowed».
 *
 * Это не стеммер и не претендует им быть: словаря английского в приложении нет и не будет,
 * а тащить его ради сносок — несоразмерно. Лестница покрывает регулярную словоизменительную
 * морфологию (число, прошедшее время, -ing) и молчит на всём остальном: непокрытая форма
 * честно показывает «сноски нет» — ровно то поведение, которое описано в `yamlfm.glossary`.
 */
function lemmaCandidates(w: string): string[] {
  const out = [w]
  const add = (s: string) => { if (s.length >= 2 && !out.includes(s)) out.push(s) }
  const doubled = (s: string) => (s.length >= 3 && s[s.length - 1] === s[s.length - 2] ? s.slice(0, -1) : '')
  if (w.endsWith('ies')) { add(w.slice(0, -3) + 'y') }
  if (w.endsWith('ied')) { add(w.slice(0, -3) + 'y') }
  if (w.endsWith('es')) { add(w.slice(0, -2)); add(w.slice(0, -1)) }
  else if (w.endsWith('s')) add(w.slice(0, -1))
  if (w.endsWith('ed')) {
    add(w.slice(0, -2))
    add(w.slice(0, -1))
    add(doubled(w.slice(0, -2)))
  }
  if (w.endsWith('ing')) {
    const base = w.slice(0, -3)
    add(base)
    add(base + 'e')
    add(doubled(base))
  }
  return out.filter(Boolean)
}

/** Сноска глоссария для формы из текста; null — такого слова в глоссарии нет. */
export function glossFor(glossary: GlossEntry[], word: string): GlossEntry | null {
  const forms = lemmaCandidates(normWord(word))
  for (const f of forms) {
    const hit = glossary.find(g => normWord(g.word) === f)
    if (hit) return hit
  }
  return null
}

/**
 * Лемма, под которой слово попадёт в журнал.
 *
 * Если глоссарий текста знает это слово, ключом становится ЕГО словарная форма: тогда
 * «borrow» и «borrowed», отмеченные в разных абзацах, — одна отметка, а не две, и порог
 * понятности текста считается по словам, а не по их формам. Вне глоссария лемма — просто
 * нормализованная форма из текста (`normWord`), как в упражнении, где глоссария нет вовсе.
 */
export function lemmaOf(glossary: GlossEntry[], word: string): string {
  const hit = glossFor(glossary, word)
  return hit ? normWord(hit.word) : normWord(word)
}

/* ---- ступень и порядок текстов -------------------------------------------- */

/**
 * Текущая ступень чтения — выводится из прочитанного, а не спрашивается настройкой
 * (тот же приём, что `scheduler.activeLevel` для слов: ступень видна из работы, и
 * спрашивать о ней — значит перекладывать на ученика то, что известно и так).
 *
 * Правило: самая низкая ступень, где остались непрочитанные тексты. Всё прочитано —
 * ступень последнего доступного текста: ниже спускаться незачем, выше подниматься нечем.
 */
export function readingLevel(texts: ReadingView[], read: ReadonlySet<string>): number {
  const levelled = texts.filter(t => !t.broken && t.level < 999)
  if (!levelled.length) return 1
  const fresh = levelled.filter(t => !read.has(t.slug))
  if (fresh.length) return Math.min(...fresh.map(t => t.level))
  return Math.max(...levelled.map(t => t.level))
}

/**
 * Порядок списка: от текущей ступени вверх, пройденные ступени — в хвост.
 *
 * Тексты ниже текущей ступени не прячутся: перечитать лёгкое можно всегда, и это законный
 * ход, когда текущая ступень оказалась тяжеловата. Но начинать список с них значит звать
 * назад, поэтому они уходят за все ступени вперёд.
 */
export function orderReadings(texts: ReadingView[], level: number): ReadingView[] {
  const rank = (t: ReadingView) => (t.level >= level ? t.level - level : 1000 + (level - t.level))
  return [...texts].sort((a, b) =>
    rank(a) - rank(b) || a.order - b.order || a.slug.localeCompare(b.slug))
}
