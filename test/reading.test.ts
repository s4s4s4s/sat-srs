/**
 * Тесты слоя данных ЧТЕНИЯ: разбор файла текста, новые строки журнала (отметка незнакомого
 * слова и прочтение текста) и восстановление состояния отметок из потока строк.
 *
 * Чтение отличается от повторений тем, что у него нет FSRS: текст не оценивают, и потерять
 * здесь можно не расписание, а сам факт работы — отметку слова. Поэтому проверяется ровно то,
 * через что отметка проходит по дороге к тьютору: круговой обход ndjson (ни одно поле не
 * теряется), слияние двух устройств (отметка не пропадает и не задваивается), устойчивость
 * разбора к битой строке и сборка текущего состояния из append-only потока, где снятие
 * отметки — это строка, а не удаление.
 *
 * Чего здесь НЕТ: IndexedDB и сети. В node их нет, а подделка проверяла бы подделку — как и в
 * соседних наборах. Два правила, неотделимых от места вызова (запись отметки не трогает FSRS;
 * схема базы мигрирует шагами, а не переписыванием upgrade), закрыты структурной проверкой
 * исходника — она честно названа структурной: ловит возврат старого кода, но не заменяет
 * живой прогон в браузере.
 *
 * Разметка текста под касание (`src/lib/reading.ts`) проверяется здесь же: это та же дорога
 * к тьютору, только её начало. Границы предложения решают, ЧТО уедет в строке отметки;
 * границы слова решают, во что вообще можно ткнуть; ступень и порядок решают, какой текст
 * человек откроет. Ошибка в любом из трёх не роняет приложение, а тихо портит данные —
 * поэтому проверки прогонные, а не структурные: чистые функции в node прогоняются целиком.
 *
 * Живой каталог текстов (../sat-deck/Учёба/Чтение) подключается, если существует: на
 * 21.08.2026 текстов ещё нет, формат описан контрактом заранее, и группа пропускается
 * с пометкой, а не падает.
 *
 * Запуск: `npm run test:reading` (esbuild бандлит файл и node его исполняет).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseMd, readingView, countWords } from '../src/lib/yamlfm'
import {
  toNdjson, parseNdjson, activeMarks, isMarked, markCount, markKey, normWord, deckHasWord,
  cardSrc, readingSrc, readingPassed, readTextSlugs, READING_UNKNOWN_SHARE_MAX, MARK_SENTENCE_MAX,
  markDigest
} from '../src/lib/journal'
import { readingsDeletionPlan } from '../src/lib/db'
import { isCardPath, isReadingPath, readingBase } from '../src/lib/sync'
import {
  splitSentences, paragraphs, segmentText, markedLemmas, glossFor, lemmaOf,
  readingLevel, orderReadings, type Segment
} from '../src/lib/reading'
import type { GlossEntry, JournalLine, ReadingRec, ReadingView } from '../src/lib/types'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }
function skip(name: string): void { console.log(`  ⚠ ${name}`) }

const SRC = path.join(process.cwd(), 'src', 'lib')
const TEXTS_DIR = process.env.SAT_TEXTS ?? path.join(process.cwd(), '..', 'sat-deck', 'Учёба', 'Чтение')

function source(file: string): string {
  const p = path.join(SRC, file)
  assert(existsSync(p), `не найден исходник ${p} — тест запускают из корня пакета`)
  // git отдаёт рабочее дерево с CRLF (core.autocrlf) — ищем по исходнику в одном виде
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * То же для экранов. Границы отметки — свойство экрана, а не слоя данных: чтение пишет в
 * `reading:<слаг>`, упражнение — в `card:<слаг>`, и в упражнении разметке подлежит только
 * условие. Прогнать это в node нельзя (React и DOM здесь нет), поэтому проверка структурная —
 * она ловит возврат старого кода, но не заменяет живой прогон в браузере.
 */
function screenSource(file: string): string {
  const p = path.join(process.cwd(), 'src', 'screens', file)
  assert(existsSync(p), `не найден исходник экрана ${p} — тест запускают из корня пакета`)
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

/** Вид текста для проверок ступени и порядка: поля разбора здесь не важны, важны level/order. */
function view(slug: string, level: number, order = 1, over: Partial<ReadingView> = {}): ReadingView {
  return {
    path: `Учёба/Чтение/${slug}.md`,
    slug,
    title: slug,
    level,
    order,
    words: 200,
    added: '2026-08-24',
    glossary: [],
    text: 'Text.',
    broken: false,
    ...over
  }
}

/** Собрать текст обратно из кусков разметки: пропуск возвращается тем же `___`, каким пришёл. */
function rebuild(segs: Segment[]): string {
  return segs.map(s => (s.kind === 'blank' ? '___' : s.text)).join('')
}

/** Только слова — цели для касания. */
function wordsOf(segs: Segment[]): Extract<Segment, { kind: 'word' }>[] {
  const out: Extract<Segment, { kind: 'word' }>[] = []
  for (const s of segs) if (s.kind === 'word') out.push(s)
  return out
}

/** Тело функции по её заголовку: от строки объявления до закрывающей скобки в нулевой колонке. */
function funcBody(src: string, header: string): string {
  const i = src.indexOf(header)
  assert(i >= 0, `в исходнике не найдено объявление «${header}» — тест устарел или функцию переименовали`)
  const j = src.indexOf('\n}\n', i)
  assert(j > i, `не найден конец функции «${header}»`)
  return src.slice(i, j)
}

// ---- фабрики ---------------------------------------------------------------

const SRC_REEF = readingSrc('2-01-reef')
const SRC_OTHER = readingSrc('3-02-kelp')

let idSeq = 0
function markLine(o: Partial<JournalLine> & { word: string }): JournalLine {
  idSeq++
  return {
    id: `m-${idSeq}`,
    v: 1,
    type: 'mark',
    ts: '2026-08-24T10:00:00+04:00',
    ms: 0,
    day: '2026-08-24',
    src: SRC_REEF,
    lemma: normWord(o.word),
    sentence: 'The moratorium held for a decade.',
    in_deck: false,
    on: true,
    ...o
  }
}

function readingLine(o: Partial<JournalLine> = {}): JournalLine {
  idSeq++
  return {
    id: `r-${idSeq}`,
    v: 1,
    type: 'reading',
    ts: '2026-08-24T10:30:00+04:00',
    ms: 12,
    day: '2026-08-24',
    slug: '2-01-reef',
    marks: 3,
    passed: true,
    ...o
  }
}

function rec(fm: Record<string, any>, body: string, over: Partial<ReadingRec> = {}): ReadingRec {
  return { path: 'Учёба/Чтение/2-01-reef.md', sha: 'sha-1', fm, body, ...over }
}

const canon = (o: Record<string, any>) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]))

/** Слияние двух устройств так, как его делает sync.pull: объединение по id, чужое не трогаем. */
function mergeDevices(mine: JournalLine[], theirs: JournalLine[]): JournalLine[] {
  const known = new Set(mine.map(l => l.id))
  return [...mine, ...theirs.filter(l => !known.has(l.id))]
}

/** Круговой обход через файл журнала: строки → ndjson → разбор. */
function roundtrip(lines: JournalLine[], raw: string[] = []): { lines: JournalLine[]; rejects: string[] } {
  return parseNdjson(toNdjson(lines, raw))
}

// ---- разбор файла текста ---------------------------------------------------

const FULL_TEXT = `---
type: reading
title: "The Reef That Refused to Die"
level: 2
order: 1
words: 12
added: 2026-08-24
glossary:
  - word: moratorium
    pos: noun
    meaning_en: "an official pause of an activity"
    meaning_ru: "мораторий, временный запрет"
---
A moratorium on fishing gave the reef a decade of quiet. It recovered.
`

function readingParseChecks(): void {
  const full = parseMd(FULL_TEXT)
  const v = readingView(rec(full.fm, full.body))
  assert(v.slug === '2-01-reef', `слаг текста берётся из имени файла, получено «${v.slug}»`)
  assert(v.title === 'The Reef That Refused to Die', 'заголовок из frontmatter')
  assert(v.level === 2 && v.order === 1, `ступень и порядок из frontmatter, получено ${v.level}/${v.order}`)
  assert(v.words === 12, `words берётся из frontmatter, получено ${v.words}`)
  assert(v.added === '2026-08-24', 'дата добавления как строка (CORE_SCHEMA)')
  assert(!v.broken, 'целый файл не битый')
  assert(v.text.startsWith('A moratorium') && v.text.endsWith('It recovered.'), 'тело без обрамляющих пустых строк')
  assert(v.glossary.length === 1, 'глоссарий разобран')
  const g = v.glossary[0]
  assert(g.word === 'moratorium' && g.pos === 'noun', 'слово и часть речи сноски')
  assert(g.meaning_en.startsWith('an official') && g.meaning_ru.startsWith('мораторий'), 'оба значения сноски')
  group('файл текста: все поля frontmatter и глоссарий разобраны')

  // недостающие поля: ступень и порядок вытягиваются из имени файла, объём считается по телу
  const bare = parseMd('---\ntype: reading\n---\nOne two three four five.\n')
  const b = readingView(rec(bare.fm, bare.body))
  assert(b.level === 2 && b.order === 1, `level/order из имени файла, получено ${b.level}/${b.order}`)
  assert(b.words === 5, `объём посчитан по телу, получено ${b.words}`)
  assert(b.title === '2-01-reef', 'заголовка нет — показываем слаг, а не пустоту')
  assert(b.added === '' && b.glossary.length === 0, 'недостающие поля не выдумываются')
  const noName = readingView(rec({}, 'x y', { path: 'Учёба/Чтение/reef.md' }))
  assert(noName.level === 999 && noName.order === 999, 'имя файла без ступени — в хвост (999), как карточка без уровня')
  group('файл текста: недостающие поля не роняют разбор и не выдумывают значений')

  // лишние поля: в вид не попадают, но и не теряются — остаются в записи
  const extra = parseMd(FULL_TEXT.replace('added: 2026-08-24', 'added: 2026-08-24\nauthor: tutor\nsource_url: example.org'))
  const r = rec(extra.fm, extra.body)
  const e = readingView(r)
  assert(e.title === 'The Reef That Refused to Die' && e.level === 2, 'лишние поля не мешают разбору')
  assert(r.fm.author === 'tutor' && r.fm.source_url === 'example.org', 'лишние поля сохраняются в записи как есть')
  assert(!('author' in (e as unknown as Record<string, any>)), 'лишние поля не протекают в типизированный вид')
  group('файл текста: лишние поля frontmatter сохранены и не протекают в вид')

  // битый yaml: parseMd отдаёт broken, вид это показывает
  const brokenSrc = '---\ntitle: "не закрыта\nlevel: [\n---\nтело\n'
  const broken = parseMd(brokenSrc)
  const bv = readingView(rec(broken.fm, broken.body, { broken: broken.broken }))
  assert(bv.broken, 'битый frontmatter помечен broken — текст не показываем')
  group('файл текста: битый frontmatter помечен, а не показан как пустой')

  // глоссарий, которому нельзя верить
  const junk = readingView(rec({ glossary: 'moratorium' }, 'x'))
  assert(junk.glossary.length === 0, 'глоссарий не массив — пусто, а не падение')
  const mixed = readingView(rec({
    glossary: ['строка', null, { pos: 'noun' }, { word: 'kelp' }, { word: 'reef', meaning_ru: 'риф' }]
  }, 'x'))
  assert(mixed.glossary.length === 2, `в глоссарии остаются только записи со словом, получено ${mixed.glossary.length}`)
  assert(mixed.glossary[0].word === 'kelp' && mixed.glossary[0].meaning_ru === '', 'неполная запись даёт пустые поля, а не undefined')
  group('глоссарий: мусорные записи отброшены, неполные не роняют текст')

  assert(countWords('  one   two\nthree  ') === 3 && countWords('   ') === 0, 'счёт токенов тела')
  group('счёт токенов тела: пробелы и переводы строк не считаются словами')
}

// ---- круговой обход новых строк -------------------------------------------

function roundtripChecks(): void {
  const mark = markLine({
    word: 'Moratorium,',
    lemma: 'moratorium',
    in_deck: true,
    sentence: 'A moratorium on fishing gave the reef a decade of quiet.',
    ms: 731
  })
  const unmark = markLine({ word: 'kelp', on: false, ms: 12 })
  const read = readingLine({ marks: 2, passed: false })
  const out = roundtrip([mark, unmark, read])
  assert(out.rejects.length === 0, 'ни одна новая строка не отбракована разбором')
  assert(out.lines.length === 3, `обход вернул ${out.lines.length} строк вместо 3`)
  for (const before of [mark, unmark, read]) {
    const after = out.lines.find(l => l.id === before.id)
    assert(!!after, `строка ${before.id} потерялась в обходе`)
    assert(canon(before as any) === canon(after as any),
      `поля строки ${before.id} изменились обходом:\n  было ${canon(before as any)}\n  стало ${canon(after as any)}`)
  }
  const marks = out.lines.filter(l => l.type === 'mark')
  assert(marks.every(l => typeof l.on === 'boolean'), 'булев признак отметки переживает json (не строкой)')
  assert(out.lines.find(l => l.type === 'reading')!.passed === false, 'false у порога не превращается в отсутствие поля')
  assert(readTextSlugs(out.lines).has('2-01-reef'), 'прочтение текста опознаётся по слагу')
  group('круговой обход ndjson: mark и reading не теряют ни одного поля')
}

function brokenLineChecks(): void {
  const good = [markLine({ word: 'moratorium' }), markLine({ word: 'kelp' })]
  const file = toNdjson(good)
    .replace('\n', '\n{"id":"обрыв","type":"mark","src":"reading:2-01-reef",\n')
    + '{"id":"без-дня","type":"mark","ts":"2026-08-24T10:00:00+04:00"}\n'
    + 'просто мусор\n'
  const out = parseNdjson(file)
  assert(out.lines.length === 2, `битые строки не должны уносить целые: разобрано ${out.lines.length} из 2`)
  assert(out.rejects.length === 3, `битые строки уходят в rejects целиком, получено ${out.rejects.length}`)
  assert(markCount(out.lines, SRC_REEF) === 2, 'отметки из целых строк считаются, несмотря на соседний мусор')
  // сырые строки возвращаются в файл при перезаписи — чужие данные не теряются
  const rewritten = parseNdjson(toNdjson(out.lines, out.rejects))
  assert(rewritten.rejects.length === 3, 'битые строки переживают перезапись месяца и не исчезают молча')
  group('битая строка: разбор остальных не падает, мусор сохраняется как есть')
}

// ---- слияние двух устройств ------------------------------------------------

function mergeChecks(): void {
  const shared = markLine({ id: 'shared-1', word: 'moratorium', ts: '2026-08-24T10:00:00+04:00' })
  // телефон: отметил ещё одно слово
  const phone = [shared, markLine({ id: 'phone-1', word: 'kelp', ts: '2026-08-24T10:01:00+04:00' })]
  // ноутбук: отметил ТО ЖЕ слово (другая форма той же леммы) и слово в другом тексте
  const laptop = [
    shared,
    markLine({ id: 'laptop-1', word: 'Moratoriums', lemma: 'moratorium', ts: '2026-08-24T10:02:00+04:00' }),
    markLine({ id: 'laptop-2', word: 'polyp', src: SRC_OTHER, ts: '2026-08-24T10:02:30+04:00' })
  ]

  const merged = roundtrip(mergeDevices(phone, laptop)).lines
  assert(merged.length === 4, `объединение по id: ожидалось 4 строки, получено ${merged.length}`)
  assert(new Set(merged.map(l => l.id)).size === merged.length, 'общая строка не задвоилась при слиянии')

  const active = activeMarks(merged, SRC_REEF)
  assert(active.length === 2, `в тексте должно остаться 2 отмеченных слова, получено ${active.length}`)
  assert(active.filter(l => markKey(l) === markKey(shared)).length === 1,
    'одно слово, отмеченное на двух устройствах, — одна отметка, а не две')
  assert(isMarked(merged, SRC_REEF, 'kelp'), 'отметка с телефона не потерялась при слиянии')
  assert(markCount(merged, SRC_OTHER) === 1, 'отметки соседнего текста не смешиваются с этим')
  group('слияние двух устройств: ничего не потеряно и ничего не задвоено')

  // снятие на одном устройстве побеждает более раннюю постановку на другом
  const withUnmark = mergeDevices(merged, [
    markLine({ id: 'phone-2', word: 'kelp', on: false, ts: '2026-08-24T10:05:00+04:00' })
  ])
  assert(!isMarked(withUnmark, SRC_REEF, 'kelp'), 'снятие позднее постановки — слово не отмечено')
  assert(markCount(withUnmark, SRC_REEF) === 1, 'снятая отметка не считается в числе отмеченных слов')
  // и обратно: постановка после снятия снова включает отметку
  const again = mergeDevices(withUnmark, [
    markLine({ id: 'laptop-3', word: 'kelp', ts: '2026-08-24T10:06:00+04:00' })
  ])
  assert(isMarked(again, SRC_REEF, 'kelp'), 'постановка после снятия возвращает отметку')
  group('снятие и повторная постановка: побеждает последнее решение, а не сумма событий')

  // порядок строк в массиве у двух устройств разный — ответ обязан совпадать
  const tieOn = markLine({ id: 'aaa', word: 'reef', on: true, ts: '2026-08-24T11:00:00+04:00', ms: 500 })
  const tieOff = markLine({ id: 'zzz', word: 'reef', on: false, ts: '2026-08-24T11:00:00+04:00', ms: 500 })
  const a = activeMarks([tieOn, tieOff], SRC_REEF).map(l => l.id).join()
  const b = activeMarks([tieOff, tieOn], SRC_REEF).map(l => l.id).join()
  assert(a === b, `совпавший до миллисекунды спор решается одинаково на обоих устройствах: «${a}» против «${b}»`)
  const shuffled = [...merged].reverse()
  assert(markCount(shuffled, SRC_REEF) === markCount(merged, SRC_REEF), 'порядок строк в памяти не влияет на состояние отметок')
  group('порядок строк не решает: спор в одну миллисекунду разрешается детерминированно')
}

// ---- сводка отметок для отчёта ----------------------------------------------

/**
 * `markDigest` сводит отметки всех источников в рабочий список для тьютора.
 *
 * Проверяется ровно то, ради чего сводка и заведена: снятое не предлагается, одно
 * слово из двух текстов не задваивается в списке слов, принадлежность к колоде
 * берётся из текущей колоды, а не из поля `in_deck` строки — иначе слово, добавленное
 * после отметки, навсегда остаётся «кандидатом».
 */
function digestChecks(): void {
  const lines = [
    markLine({ id: 'd1', word: 'moratorium', ts: '2026-08-24T10:00:00+04:00', sentence: 'The moratorium held.' }),
    markLine({ id: 'd2', word: 'Moratoriums', lemma: 'moratorium', src: SRC_OTHER, ts: '2026-08-24T10:01:00+04:00' }),
    markLine({ id: 'd3', word: 'kelp', ts: '2026-08-24T10:02:00+04:00' }),
    markLine({ id: 'd4', word: 'kelp', on: false, ts: '2026-08-24T10:03:00+04:00' }),
    markLine({ id: 'd5', word: 'bolster', src: cardSrc('bolster'), ts: '2026-08-24T10:04:00+04:00' })
  ]
  // колода знает bolster (карточка живая) и не знает moratorium
  const d = markDigest(lines, new Set(['bolster']))

  assert(d.total === 3, `снятое не считается: ожидалось 3 живых отметки, получено ${d.total}`)
  assert(d.fromReading === 2 && d.fromCards === 1,
    `источники разведены: тексты ${d.fromReading}, задания ${d.fromCards}`)
  assert(d.entries.length === 2, `разных слов должно быть 2, получено ${d.entries.length}`)

  const mora = d.entries.find(e => e.lemma === 'moratorium')
  assert(!!mora, 'слово, отмеченное в двух текстах, не потерялось')
  assert(mora!.marks === 2 && mora!.fromReading === 2,
    `одно слово из двух текстов — одна строка списка с двумя отметками, получено ${mora!.marks}`)
  assert(mora!.sample === 'The moratorium held.', 'предложение первой отметки уехало в сводку как контекст для карточки')
  assert(!mora!.inDeck, 'слова нет в колоде — оно кандидат')

  const bol = d.entries.find(e => e.lemma === 'bolster')
  assert(bol!.inDeck && bol!.fromCards === 1, 'слово с живой карточкой помечено как уже в колоде')
  assert(d.entries[0].lemma === 'moratorium',
    'кандидаты идут первыми: список читают ради того, что надо добавить')
  assert(!d.entries.some(e => e.lemma === 'kelp'), 'снятая отметка не предлагается в карточки')
  group('сводка отметок: снятое отброшено, источники разведены, кандидаты впереди')

  // принадлежность к колоде — по текущей колоде, а не по историческому полю строки
  const later = markDigest(lines, new Set(['bolster', 'moratorium']))
  assert(later.entries.find(e => e.lemma === 'moratorium')!.inDeck,
    'слово, добавленное в колоду ПОСЛЕ отметки, перестаёт быть кандидатом')
  assert(lines[0].in_deck === false,
    'историческое поле строки при этом не переписано — журнал append-only')
  group('принадлежность к колоде считается по текущей колоде, а не по полю отметки')

  assert(activeMarks(lines).length === 3,
    'activeMarks без источника отдаёт отметки всех источников сразу')
  assert(activeMarks(lines, SRC_REEF).length === 1,
    'с источником — по-прежнему только его отметки')
  group('activeMarks: без источника — вся работа, с источником — один текст')
}

// ---- восстановление состояния ----------------------------------------------

function markStateChecks(): void {
  const stream = [
    markLine({ id: 's1', word: 'moratorium', ts: '2026-08-24T10:00:00+04:00' }),
    markLine({ id: 's2', word: 'moratorium', on: false, ts: '2026-08-24T10:01:00+04:00' }),
    markLine({ id: 's3', word: 'Moratorium.', lemma: 'moratorium', ts: '2026-08-24T10:02:00+04:00' }),
    markLine({ id: 's4', word: 'kelp', ts: '2026-08-24T10:03:00+04:00' }),
    markLine({ id: 's5', word: 'kelp', on: false, ts: '2026-08-24T10:04:00+04:00' })
  ]
  const active = activeMarks(stream, SRC_REEF)
  assert(active.length === 1 && active[0].id === 's3',
    `состояние собирается из последнего решения по каждой лемме, получено [${active.map(l => l.id).join()}]`)
  assert(isMarked(stream, SRC_REEF, 'moratorium'), 'слово отмечено последней постановкой')
  assert(!isMarked(stream, SRC_REEF, 'kelp'), 'снятое слово не отмечено')
  assert(isMarked(stream, SRC_REEF, 'Moratoriums,', 'moratorium'), 'опознание идёт по лемме, а не по форме в тексте')
  group('состояние отметок: последнее решение по лемме, снятие учтено')

  // строка без `on` — это поставленная отметка: старый или чужой писатель не должен исчезать
  const legacy = [{ ...markLine({ word: 'reef' }), on: undefined } as JournalLine]
  assert(markCount(legacy, SRC_REEF) === 1, 'строка отметки без поля on читается как поставленная')
  // ни отметка, ни снятие не удаляют строк — журнал остаётся append-only
  assert(stream.length === 5 && stream.filter(l => l.on === false).length === 2,
    'снятие выражено строками, а не удалением: обе строки снятия на месте')
  group('append-only: снятие — это строка, а не исчезновение прежней')

  // строка без слова и леммы не образует отметки (иначе один ключ склеил бы всё подряд)
  assert(markKey(markLine({ word: '  ,  ', lemma: '' })) === '', 'бессловесная строка не даёт ключа')
  assert(markCount([markLine({ word: '—', lemma: '' })], SRC_REEF) === 0, 'бессловесная строка не считается отметкой')
  group('ключ отметки: пунктуация без букв отметкой не становится')

  assert(normWord('  “Moratorium,” ') === 'moratorium', 'нормализация снимает регистр и обрамляющую пунктуацию')
  assert(normWord('deter-2') === 'deter', 'разводящий суффикс слага не мешает сравнению со словом')
  const deck = new Set(['moratorium', 'reef'])
  assert(deckHasWord(deck, 'Moratorium', 'moratoriums'), 'слово опознаётся в колоде по любой из форм')
  assert(!deckHasWord(deck, 'kelp', undefined), 'чужого слова в колоде нет')
  assert(!deckHasWord(deck, '', undefined), 'пустая форма не считается совпадением')
  group('признак «слово уже в колоде»: сравнение по нормализованной форме')
}

function thresholdChecks(): void {
  assert(READING_UNKNOWN_SHARE_MAX === 0.02, 'порог понятности — 2% незнакомых слов')
  assert(readingPassed(16, 840), 'на тексте в 840 слов 16 отметок укладываются в порог')
  assert(!readingPassed(17, 840), 'на тексте в 840 слов 17 отметок порог не берут')
  assert(readingPassed(0, 600) && !readingPassed(1, 20), 'порог считается долей, а не абсолютным числом')
  assert(!readingPassed(0, 0), 'текст без слов порога не берёт: считать нечего')
  group('порог понятности текста: доля отметок от объёма, а не их число')
}

// ---- каналы: пути и удаление -----------------------------------------------

function pathChecks(): void {
  const base = 'Учёба/Карточки'
  assert(readingBase(base) === 'Учёба/Чтение', `каталог текстов — сосед колоды, получено «${readingBase(base)}»`)
  assert(readingBase('Учёба/Карточки/') === 'Учёба/Чтение', 'хвостовой слэш в настройке не ломает путь')
  assert(readingBase('Карточки') === 'Чтение', 'колода в корне репозитория тоже даёт соседний каталог')
  assert(isReadingPath('Учёба/Чтение/2-01-reef.md', base), 'текст опознаётся')
  assert(!isReadingPath('Учёба/Чтение/_черновик.md', base), 'служебный файл текстом не считается')
  assert(!isReadingPath('Учёба/Чтение/2-01-reef.txt', base), 'не-md текстом не считается')
  assert(!isReadingPath('Учёба/Карточки/abstract.md', base), 'карточка текстом не считается')
  assert(!isCardPath('Учёба/Чтение/2-01-reef.md', base), 'текст карточкой не считается')
  assert(isReadingPath('Учёба/Чтение/2-01-reef.md'.normalize('NFD'), base),
    'путь в другой нормализации Unicode (macOS отдаёт NFD) опознаётся как текст')
  group('каналы: каталог текстов выводится из пути колоды и не пересекается с ней')
}

function deletionKeepsHistoryChecks(): void {
  const local = [{ path: 'Учёба/Чтение/2-01-reef.md' }, { path: 'Учёба/Чтение/3-02-kelp.md' }]
  const remote = ['Учёба/Чтение/3-02-kelp.md']
  const plan = readingsDeletionPlan(local, remote)
  assert(plan.length === 1 && plan[0] === 'Учёба/Чтение/2-01-reef.md', 'исчезнувший в репозитории текст удаляется локально')
  assert(readingsDeletionPlan(local, local.map(r => r.path.normalize('NFD'))).length === 0,
    'путь в другой нормализации Unicode не выглядит удалённым — иначе снесло бы всё разом')

  // журнал живёт в другом хранилище: удаление текста его не касается
  const journal = roundtrip([
    markLine({ id: 'keep-1', word: 'moratorium', sentence: 'A moratorium on fishing gave the reef a decade of quiet.' }),
    readingLine({ id: 'keep-2', marks: 1, passed: true })
  ]).lines
  const survived = activeMarks(journal, SRC_REEF)
  assert(survived.length === 1, 'отметка пережила удаление текста')
  assert(survived[0].word === 'moratorium' && !!survived[0].sentence,
    'строка отметки самодостаточна: слово и предложение в ней, а не в исчезнувшем тексте')
  assert(readTextSlugs(journal).has('2-01-reef'), 'запись о прочтении пережила удаление текста')
  group('удалённый текст не уносит историю чтения: отметки и прочтения остаются в журнале')
}

// ---- структурные проверки (то, что нельзя прогнать в node) ------------------

function structureChecks(): void {
  const store = source('store.ts')
  const toggle = funcBody(store, 'export async function toggleWordMark')
  const logRead = funcBody(store, 'export async function logTextRead')
  for (const [name, body] of [['toggleWordMark', toggle], ['logTextRead', logRead]] as const) {
    assert(!/fsrs/i.test(body), `${name} не имеет права трогать FSRS: чтение не оценивают`)
    assert(body.includes('db.putJournal'), `${name} обязана писать строку журнала`)
    assert(!/\bdb\.delete|store\.delete|putCard\b/.test(body), `${name} ничего не удаляет и не пишет карточек`)
  }
  assert(toggle.includes("type: 'mark'") && logRead.includes("type: 'reading'"), 'типы строк проставлены явно')
  assert(/on,|on:/.test(toggle), 'отметка пишет признак включения/снятия')
  assert(logRead.includes('readingPassed'), 'строка прочтения считает порог, а не принимает его снаружи')
  assert(logRead.includes('markCount'), 'число отметок берётся из журнала, а не из аргумента экрана')
  group('структурно: запись чтения не касается FSRS и ничего не удаляет')

  const db = source('db.ts')
  assert(db.includes('const DB_VERSION = 2'), 'версия локальной базы поднята под хранилище текстов')
  assert(db.includes('oldVersion < 1') && db.includes('oldVersion < 2'),
    'миграция схемы идёт шагами oldVersion: без них установленное PWA упало бы на createObjectStore')
  assert(db.includes("createObjectStore('readings'"), 'хранилище текстов создаётся отдельным шагом')
  const clear = funcBody(db, 'export async function clearLocalData')
  assert(clear.includes('readings'), 'сброс кэша чистит и тексты — иначе они пережили бы «начать заново»')
  group('структурно: схема базы мигрирует шагами, а не пересозданием хранилищ')

  const sentence = markLine({ word: 'x', sentence: 'ю'.repeat(MARK_SENTENCE_MAX + 50) })
  assert(sentence.sentence!.length > MARK_SENTENCE_MAX, 'фабрика проверяет именно длинное предложение')
  const store_ = funcBody(store, 'export async function toggleWordMark')
  assert(store_.includes('MARK_SENTENCE_MAX'), 'предложение в отметке зажато потолком')
  group('структурно: предложение отметки зажато потолком длины')
}

// ---- живые тексты (если каталог существует) --------------------------------

function liveTextsChecks(): boolean {
  if (!existsSync(TEXTS_DIR)) {
    skip(`живые тексты не подключались: каталога ${TEXTS_DIR} нет (на 21.08.2026 текстов ещё не написано)`)
    return false
  }
  const files = readdirSync(TEXTS_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'))
  if (!files.length) {
    skip(`живые тексты не подключались: в ${TEXTS_DIR} нет файлов`)
    return false
  }
  let words = 0
  for (const f of files) {
    const raw = readFileSync(path.join(TEXTS_DIR, f), 'utf8')
    const parsed = parseMd(raw)
    const v = readingView({ path: `Учёба/Чтение/${f}`, sha: 'live', fm: parsed.fm, body: parsed.body, broken: parsed.broken })
    assert(!v.broken, `живой текст ${f} не разобрался — почините frontmatter`)
    assert(v.level >= 1 && v.level <= 6, `у текста ${f} ступень вне 1–6: ${v.level}`)
    assert(v.words > 0 && v.text.length > 0, `текст ${f} пуст`)
    assert(v.glossary.every(g => !!g.word), `в глоссарии ${f} есть сноска без слова`)
    words += v.words
  }
  group(`живые тексты: ${files.length} файлов, ${words} слов — разобраны все`)
  return true
}

// ---- разбиение на предложения (правило контракта) ---------------------------

function sentenceChecks(): void {
  const s = splitSentences('The reef recovered. Fishing resumed! Did it last? Nobody knows.')
  assert(s.length === 4, `правило контракта «.!? + пробел + заглавная»: ждали 4 предложения, вышло ${s.length} — [${s.join(' | ')}]`)
  assert(s[0] === 'The reef recovered.', `предложение отдаётся вместе со своим знаком конца, вышло «${s[0]}»`)
  assert(s[2] === 'Did it last?', `вопрос — тоже конец предложения, вышло «${s[2]}»`)
  assert(s[3] === 'Nobody knows.', `последнее предложение не теряется, вышло «${s[3]}»`)
  // строчная после точки предложения не начинает: правило контракта, а не догадка о смысле
  assert(splitSentences('the reef recovered. fishing resumed.').length === 1,
    'строчная буква после точки нового предложения не начинает')
  // точка без пробела концом не считается — иначе развалились бы числа и адреса
  assert(splitSentences('It cost 3.5 million dollars.').length === 1, 'десятичная дробь предложение не рвёт')
  assert(splitSentences('').length === 0 && splitSentences('   ').length === 0, 'пустая строка предложений не даёт')
  assert(splitSentences('No final period here').length === 1, 'текст без точки в конце — одно предложение, а не ноль')
  group('предложения: правило контракта — знак конца, пробел и заглавная')
}

function abbreviationChecks(): void {
  /* Сокращения. В самих текстах для чтения их держит ошибкой машинная проверка колоды, но тем
     же разбиением режется контекст карточки, где «Dr.» и «U.S.» законны. Выбор здесь
     сознательный: спорную точку лучше НЕ считать концом. Склеенные предложения дают отметке
     чуть более длинный контекст (его и так режет MARK_SENTENCE_MAX), а лишний разрез отправил
     бы тьютору обрубок — «Dr.» вместо фразы, в которой стояло слово. */
  const dr = splitSentences('Dr. Vance studied the reef. It recovered.')
  assert(dr.length === 2, `«Dr.» предложение не заканчивает: вышло ${dr.length} — [${dr.join(' | ')}]`)
  assert(dr[0] === 'Dr. Vance studied the reef.', `сокращение осталось внутри предложения, вышло «${dr[0]}»`)
  const us = splitSentences('The U.S. Senate voted. The bill failed.')
  assert(us.length === 2, `буквенная аббревиатура «U.S.» предложение не заканчивает: вышло ${us.length} — [${us.join(' | ')}]`)
  const init = splitSentences('The book by J. R. R. Tolkien sold well. Reprints followed.')
  assert(init.length === 2, `инициалы предложение не заканчивают: вышло ${init.length} — [${init.join(' | ')}]`)
  assert(splitSentences('Fish, coral, etc. All of it returned.').length === 1,
    'спорная точка после «etc.» разрезом не становится: склейка честнее обрубка')
  // обычное слово перед точкой концом предложения быть не перестаёт
  const plain = splitSentences('The fish left the bay. Divers noticed.')
  assert(plain.length === 2, `обычное слово перед точкой конец предложения не отменяет: вышло ${plain.length}`)
  group('предложения: сокращения и инициалы точку концом не делают')
}

// ---- разметка текста на слова ----------------------------------------------

function segmentChecks(): void {
  const text = 'Dr. Vance studied the reef for 12 years. Fishing stopped there.'
  const segs = segmentText(text)
  assert(rebuild(segs) === text, 'разметка отдаёт текст ровно таким, каким он пришёл: ни символа не потеряно и не добавлено')
  const w = wordsOf(segs)
  assert(w.some(x => x.text === 'Vance'), 'слово — цель для касания')
  assert(!w.some(x => x.text === '12'), 'число целью для касания не становится: markKey отдал бы пустой ключ')
  assert(segs.some(x => x.kind === 'plain' && x.text.includes('12')), 'число не исчезает — оно просто обычный текст')
  assert(w.every(x => !!x.lemma), 'у каждой цели для касания есть непустая лемма')
  group('разметка: слова — цели для касания, текст восстанавливается посимвольно')

  // каждое слово несёт СВОЁ предложение: строка отметки обязана быть самодостаточной
  assert(w.find(x => x.text === 'Vance')!.sentence === 'Dr. Vance studied the reef for 12 years.',
    'слово несёт предложение, в котором стоит (вместе с сокращением в начале)')
  assert(w.find(x => x.text === 'Fishing')!.sentence === 'Fishing stopped there.',
    'слово из второго предложения несёт второе предложение, а не весь текст')
  const uniq = new Set(w.map(x => x.sentence))
  assert(uniq.size === 2, `предложений ровно два, а не по одному на слово: вышло ${uniq.size}`)
  group('разметка: каждое слово несёт своё предложение для строки отметки')

  const hyphen = wordsOf(segmentText("A well-known fact: fish don't vote."))
  assert(hyphen.some(x => x.text === 'well-known'), 'дефис внутри слова его не рвёт')
  assert(hyphen.some(x => x.text === "don't"), 'апостроф внутри слова его не рвёт')
  assert(!hyphen.some(x => x.text === 'well' || x.text === 'don'), 'половинок слова среди целей для касания нет')
  group('разметка: дефис и апостроф внутри слова целью для касания не разрезаются')
}

function tokenEdgeChecks(): void {
  const us = wordsOf(segmentText('People in the U.S. see the Sun rise later.'))
  const texts = us.map(x => x.text)
  assert(texts.includes('U.S.'), `буквенная аббревиатура — одна цель для касания, вышло [${texts.join(' ')}]`)
  assert(!texts.includes('U') && !texts.includes('S'),
    'аббревиатура не рассыпается на буквы: тап по «U» отправил бы тьютору отметку из ниоткуда')
  assert(us.find(x => x.text === 'U.S.')!.lemma === 'u.s', 'у аббревиатуры один ключ отметки, а не по ключу на букву')

  // одиночные буквы целями не становятся, но из текста не исчезают
  const init = 'A book by J. R. R. Tolkien.'
  const segs = segmentText(init)
  assert(rebuild(segs) === init, 'артикль и инициалы остаются в тексте ровно как были')
  const targets = wordsOf(segs).map(x => x.text).join()
  assert(targets === 'book,by,Tolkien', `инициалы и артикль целями для касания не становятся, вышло [${targets}]`)

  // точка с пробелом слова не склеивает — иначе «Dr.» съел бы имя следующим за ним
  const dr = wordsOf(segmentText('Dr. Vance studied the reef.')).map(x => x.text).join()
  assert(dr === 'Dr,Vance,studied,the,reef', `точка с пробелом оставляет слова разными, вышло [${dr}]`)
  group('разметка: «U.S.» — одна цель, инициалы и одиночные буквы целями не становятся')
}

function cardContextChecks(): void {
  const ctx = 'If $x + 3 = 7$, the value is ___ than before.'
  const segs = segmentText(ctx, { blanks: true })
  assert(segs.some(s => s.kind === 'tex' && s.text === '$x + 3 = 7$'), 'формула остаётся одним куском — её рисует KaTeX')
  assert(segs.filter(s => s.kind === 'blank').length === 1, 'пропуск карточки распознан ровно один раз')
  const inside = wordsOf(segs).map(x => x.text)
  assert(!inside.includes('x'), 'нутро формулы на слова не разбирается: в формуле отмечать нечего')
  assert(inside.includes('value') && inside.includes('before'), 'обычные слова условия целями для касания остались')
  assert(rebuild(segs) === ctx, 'условие карточки восстанавливается вместе с формулой и пропуском')
  group('условие карточки: формула и пропуск разметке не подлежат, слова вокруг — подлежат')

  // в тексте для чтения пропусков нет: подчёркивания там — обычная пунктуация
  const read = 'the value is ___ than before.'
  const plain = segmentText(read)
  assert(!plain.some(s => s.kind === 'blank'), 'без blanks подчёркивания пропуском не становятся')
  assert(rebuild(plain) === read, 'подчёркивания остаются в тексте как есть')
  group('текст для чтения: подчёркивания — обычная пунктуация, а не пропуск карточки')
}

// ---- подсветка отмеченных слов ---------------------------------------------

function highlightChecks(): void {
  const lines = [
    markLine({ id: 'hl-1', word: 'Moratorium,', lemma: 'moratorium', ts: '2026-08-24T10:00:00+04:00' }),
    markLine({ id: 'hl-2', word: 'kelp', ts: '2026-08-24T10:01:00+04:00' }),
    markLine({ id: 'hl-3', word: 'kelp', on: false, ts: '2026-08-24T10:05:00+04:00' }),
    markLine({ id: 'hl-4', word: 'polyp', src: SRC_OTHER, ts: '2026-08-24T10:02:00+04:00' })
  ]
  const on = markedLemmas(lines, SRC_REEF)
  assert(on.has('moratorium'), 'отмеченное слово горит при возврате в текст')
  assert(!on.has('kelp'), 'снятая отметка подсветку снимает')
  assert(!on.has('polyp'), 'отметки соседнего текста в этом не подсвечиваются')
  assert(on.size === 1, `подсвечено ровно одно слово, вышло ${on.size}`)
  assert(markedLemmas(lines, cardSrc('2-01-reef')).size === 0,
    'отметки текста не подсвечиваются в упражнении: источники разные')
  group('подсветка: горит последнее решение по лемме, чужой источник не влияет')

  /* Подсветка идёт по лемме, а не по форме: «Moratoriums» в одном абзаце и «moratorium» в
     другом — одно слово, и гореть обязаны оба. Словарную форму даёт глоссарий текста —
     ровно так же, как её берёт экран чтения (`lemmaOf` в Reading.tsx). */
  const gl: GlossEntry[] = [{ word: 'moratorium', pos: 'noun', meaning_en: 'an official pause', meaning_ru: 'мораторий' }]
  const body = 'Moratoriums saved the reef. The moratorium held.'
  const lit: string[] = []
  for (const s of wordsOf(segmentText(body))) if (on.has(lemmaOf(gl, s.text))) lit.push(s.text)
  assert(lit.join() === 'Moratoriums,moratorium', `обе формы отмеченного слова горят, вышло [${lit.join()}]`)
  // без глоссария (упражнение) горит только совпавшая форма — лемматизировать нечем
  const bare: string[] = []
  for (const s of wordsOf(segmentText(body))) if (on.has(s.lemma)) bare.push(s.text)
  assert(bare.join() === 'moratorium', `без глоссария горит форма, совпавшая с леммой, вышло [${bare.join()}]`)
  group('подсветка: словарная форма из глоссария склеивает формы одного слова')
}

function glossChecks(): void {
  const gl: GlossEntry[] = [
    { word: 'moratorium', pos: 'noun', meaning_en: 'an official pause', meaning_ru: 'мораторий' },
    { word: 'recover', pos: 'verb', meaning_en: 'to return to health', meaning_ru: 'восстанавливаться' },
    { word: 'colony', pos: 'noun', meaning_en: 'a group living together', meaning_ru: 'колония' }
  ]
  assert(glossFor(gl, 'moratorium')!.meaning_ru === 'мораторий', 'сноска находится по точной форме')
  assert(glossFor(gl, 'Moratoriums,')!.word === 'moratorium', 'множественное число доходит до словарной формы')
  assert(glossFor(gl, 'recovered')!.word === 'recover', 'прошедшее время доходит до словарной формы')
  assert(glossFor(gl, 'recovering')!.word === 'recover', 'форма на -ing доходит до словарной формы')
  assert(glossFor(gl, 'colonies')!.word === 'colony', 'форма на -ies доходит до словарной формы')
  // непокрытая форма честно отдаёт «сноски нет» вместо чужой сноски
  assert(glossFor(gl, 'kelp') === null, 'слова вне глоссария нет — и подсовывать соседнее нельзя')
  assert(glossFor([], 'moratorium') === null, 'пустой глоссарий сносок не выдумывает')
  group('глоссарий: словоизменение доходит до сноски, чужая сноска не подставляется')

  assert(lemmaOf(gl, 'Moratoriums') === 'moratorium', 'ключом отметки становится словарная форма из глоссария')
  assert(lemmaOf(gl, 'Kelp,') === 'kelp', 'вне глоссария ключ — нормализованная форма из текста')
  assert(lemmaOf([], 'Reefs.') === 'reefs', 'в упражнении глоссария нет вовсе — ключ просто нормализован')
  assert(lemmaOf(gl, 'recovered') === lemmaOf(gl, 'recovering'), 'две формы одного слова дают один ключ, а не две отметки')
  group('ключ отметки: формы одного слова склеиваются глоссарием в одну отметку')
}

// ---- ступень и порядок текстов ---------------------------------------------

function levelChecks(): void {
  const texts = [view('1-01-a', 1, 1), view('1-02-b', 1, 2), view('2-01-c', 2, 1), view('3-01-d', 3, 1)]
  const read = (...slugs: string[]) => new Set(slugs)
  assert(readingLevel(texts, read()) === 1, 'ничего не прочитано — нижняя ступень')
  assert(readingLevel(texts, read('1-01-a')) === 1, 'ступень держится, пока на ней осталось непрочитанное')
  assert(readingLevel(texts, read('1-01-a', '1-02-b')) === 2, 'ступень поднимается, когда нижняя пройдена целиком')
  assert(readingLevel(texts, read('2-01-c')) === 1, 'текст, прочитанный сверху, ступень не задирает: снизу ещё есть работа')
  assert(readingLevel(texts, read('1-01-a', '1-02-b', '2-01-c', '3-01-d')) === 3,
    'всё прочитано — остаёмся на верхней ступени, а не падаем в первую')
  assert(readingLevel([], read()) === 1, 'текстов нет — первая ступень, а не падение')
  assert(readingLevel([view('reef', 999)], read()) === 1, 'только тексты без ступени — первая ступень')
  assert(readingLevel([view('reef', 999), view('1-01-a', 1)], read()) === 1, 'текст без ступени (999) ступень не задирает')
  assert(readingLevel([view('2-01-c', 2, 1, { broken: true }), view('1-01-a', 1)], read()) === 1,
    'битый текст в выборе ступени не участвует — показывать его нечем')
  group('ступень чтения выводится из прочитанного, а не спрашивается настройкой')
}

function orderChecks(): void {
  const texts = [view('3-01-d', 3, 1), view('1-01-a', 1, 1), view('2-02-c', 2, 2), view('2-01-b', 2, 1)]
  const at2 = orderReadings(texts, 2).map(t => t.slug).join()
  assert(at2 === '2-01-b,2-02-c,3-01-d,1-01-a', `от текущей ступени вверх, пройденные ступени — в хвост; вышло ${at2}`)
  const at1 = orderReadings(texts, 1).map(t => t.slug).join()
  assert(at1 === '1-01-a,2-01-b,2-02-c,3-01-d', `на нижней ступени порядок просто по возрастанию; вышло ${at1}`)
  assert(orderReadings(texts, 2).length === texts.length, 'порядок ничего не прячет: перечитать лёгкое можно всегда')
  assert(texts[0].slug === '3-01-d', 'сортировка не переворачивает исходный список на месте')
  const tie = [view('b', 2, 1), view('a', 2, 1)]
  assert(orderReadings(tie, 2).map(t => t.slug).join() === 'a,b',
    'при равных ступени и порядке решает слаг — список не скачет между показами')
  group('порядок текстов: от текущей ступени вверх, пройденные ступени в хвост')
}

function paragraphChecks(): void {
  const body = 'First line\nsame paragraph.\n\nSecond paragraph.\n\n\n  Third.  \n'
  const ps = paragraphs(body)
  assert(ps.length === 3, `пустая строка делит абзацы, вышло ${ps.length} — [${ps.join(' | ')}]`)
  assert(ps[0] === 'First line same paragraph.', `одиночный перенос внутри абзаца — обычный пробел, вышло «${ps[0]}»`)
  assert(ps[2] === 'Third.', `края абзаца обрезаются, вышло «${ps[2]}»`)
  assert(paragraphs('   ').length === 0, 'пустое тело абзацев не даёт')
  assert(paragraphs('Single.').join() === 'Single.', 'текст без пустых строк — один абзац')
  group('абзацы: пустая строка делит, одиночный перенос — обычный пробел')
}

// ---- структурные проверки экранов ------------------------------------------

function screenChecks(): void {
  const reading = screenSource('Reading.tsx')
  assert(reading.includes('toggleWordMark'), 'экран чтения ставит отметку общей функцией store, а не своей записью')
  assert(reading.includes('logTextRead'), 'дочитанный текст пишется через logTextRead')
  assert(reading.includes('readingSrc('), 'источник отметки — readingSrc, а не собранная на месте строка')
  assert(!reading.includes('cardSrc'), 'экран чтения не пишет отметок в источник упражнения')
  assert(!/putJournal/.test(reading), 'экран не пишет в базу мимо store')
  assert(!/fetch\(|openai|anthropic/i.test(reading),
    'в момент касания модель не зовут: слово уходит строкой журнала, разбор — за контуром ПК')
  assert(reading.includes('readingPassed'), 'итог чтения считает порог слоя данных, а не своя формула на экране')
  group('структурно: экран чтения пишет через store и не зовёт модель по касанию')

  const review = screenSource('Review.tsx')
  assert(review.includes('cardSrc('), 'отметка в упражнении уходит в источник карточки')
  assert(!review.includes('readingSrc'), 'упражнение не пишет в источник текста: порог понятности считается по своим отметкам')
  assert(review.includes('toggleWordMark'), 'отметка в упражнении идёт той же функцией store, что и в чтении')
  const count = (review.match(/<Markable/g) ?? []).length
  assert(count === 1, `<Markable> в упражнении ровно один — только условие; найдено ${count}`)
  assert(funcBody(review, 'function Sentence').includes('<Markable'), 'разметка живёт в предложении условия')
  const after = review.slice(review.indexOf('mc-stack'))
  assert(after.includes('<Tex text={o} />'), 'варианты ответа рисует Tex — формулы в них остаются формулами')
  assert(!after.includes('<Markable'), 'варианты ответа и разбор разметке не подлежат: там тап — это ответ')
  group('структурно: разметка в упражнении только в условии, варианты и разбор не тронуты')
}

function main(): void {
  console.log('SRS чтение — разбор текста, отметки слов, слияние устройств')
  readingParseChecks()
  roundtripChecks()
  brokenLineChecks()
  mergeChecks()
  digestChecks()
  markStateChecks()
  thresholdChecks()
  pathChecks()
  deletionKeepsHistoryChecks()
  sentenceChecks()
  abbreviationChecks()
  segmentChecks()
  tokenEdgeChecks()
  cardContextChecks()
  highlightChecks()
  glossChecks()
  levelChecks()
  orderChecks()
  paragraphChecks()
  structureChecks()
  screenChecks()
  const live = liveTextsChecks()
  console.log(`\nВсе проверки чтения пройдены (${passed} групп)${live ? '' : ', живые тексты не подключались'}.`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ ЧТЕНИЯ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
