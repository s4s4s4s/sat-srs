/**
 * Регрессионные тесты слоя данных: src/lib/yamlfm.ts, src/lib/journal.ts и чистые
 * функции src/lib/db.ts. До этого набора слой данных не имел НИ ОДНОГО теста при
 * 272 проверках на планировщик/метрики/математику/звук/разбор — а это единственное
 * место в проекте, где может потеряться прогресс ученика: круговой обход
 * frontmatter (serializeMd/parseMd), зоны владения при слиянии конфликтов
 * (mergeCard) и круговой обход журнала (toNdjson/parseNdjson).
 *
 * Сеть и IndexedDB не подменяются — их здесь просто нет. src/lib/db.ts почти
 * целиком обёрнут вокруг openDB('idb') и тестируется только в двух чистых местах
 * (hasRatedFsrs, MassDeleteError); src/lib/sync.ts целиком — GitHubClient (сеть) +
 * db (IndexedDB), и не экспортирует ни одной чистой функции — см. отчёт задачи.
 *
 * Отдельная необязательная группа гоняет parseMd/serializeMd и toNdjson/parseNdjson
 * на ЖИВОЙ колоде (C:\Users\sasha\dev\sat-deck\Учёба\Карточки) — 468 карточек и
 * 704 строки журнала за июль–август. Путь существует только на этой машине,
 * поэтому группа пропускается (не падает), если каталога нет.
 *
 * Запуск: `npm run test:data` (esbuild бандлит файл и node его исполняет).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serializeMd, parseMd, mergeCard } from '../src/lib/yamlfm'
import { toNdjson, parseNdjson, cardTimeCap, CARD_TIME_CAP_MS } from '../src/lib/journal'
import { hasRatedFsrs, MassDeleteError } from '../src/lib/db'
import { monthOfDay } from '../src/lib/daytime'
import type { CardRec, JournalLine, JournalRec } from '../src/lib/types'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }
function skip(name: string): void { console.log(`  ⚠ ${name}`) }

// ---- фабрики ---------------------------------------------------------------

function localCard(fm: Record<string, any>, body = 'локальное тело'): CardRec {
  return { path: 'Учёба/Карточки/тест.md', sha: 'sha-local', fm, body, dirty: 1 }
}

let idSeq = 0
function line(o: Partial<JournalLine> = {}): JournalLine {
  idSeq++
  return {
    id: `id-${idSeq}`,
    type: 'review',
    ts: `2026-07-${String(10 + idSeq).padStart(2, '0')}T10:00:00+03:00`,
    day: `2026-07-${String(10 + idSeq).padStart(2, '0')}`,
    slug: `word${idSeq}`,
    format: 'type',
    rating: 3,
    ...o
  }
}

// ---- serializeMd/parseMd: круговой обход без потери полей -----------------

function fmRoundtripChecks(): void {
  const fm = {
    word: 'corroborate', pos: 'verb', level: 4, suspended: false, desmos: true,
    added: '2026-07-19', stability: 1.3961, reps: 22,
    contexts: ['первый контекст', 'второй контекст'],
    confusables: ['substantiate', 'collaborate'],
    fsrs: {
      state: 2, due: '2026-08-22T10:19:08.973Z', stability: 1.3961, difficulty: 9.9312,
      elapsed_days: 1, scheduled_days: 1, learning_steps: 0, reps: 22, lapses: 2,
      last_review: '2026-08-21T10:19:08.973Z'
    },
    my_sentence: '',
    empty_array: [] as string[]
  }
  const body = 'Тело карточки после frontmatter.\nВторая строка.\n'
  const s = serializeMd(fm, body)
  const { fm: fm2, body: body2, broken } = parseMd(s)
  assert(!broken, 'valid frontmatter не должен помечаться broken')
  assert(body2 === body, 'тело должно пережить круг без изменений')
  assert(JSON.stringify(fm2) === JSON.stringify(fm), 'frontmatter должен пережить круг без потери полей и без дрейфа значений')
  // выборочно — вложенный объект и массив не расплющились и не потеряли элементы
  assert(fm2.fsrs.reps === 22 && fm2.fsrs.state === 2, 'вложенный блок fsrs должен сохраниться целиком')
  assert(Array.isArray(fm2.contexts) && fm2.contexts.length === 2, 'массив contexts должен сохранить все элементы')
  group('serializeMd/parseMd: круговой обход без потери полей и дрейфа значений (числа, булевы, массивы, вложенный fsrs-блок)')
}

function fmUnicodeChecks(): void {
  const fm = {
    word: 'тест', meaning_ru: 'значение с эмодзи 🎉 и «кавычками»',
    context: 'Предложение на русском 😀 с эмодзи в контексте.',
    roots: 'при- (близость) + ставка'
  }
  const s = serializeMd(fm, 'тело\n')
  const { fm: fm2, broken } = parseMd(s)
  assert(!broken, 'кириллица/эмодзи не должны ломать разбор')
  assert(fm2.meaning_ru === fm.meaning_ru, 'кириллица + эмодзи должны пережить круг без изменений')
  assert(fm2.context === fm.context, 'эмодзи в середине строки должны сохраниться')
  group('serializeMd/parseMd: юникод (кириллица, эмодзи) переживает круг')
}

function fmLongLineChecks(): void {
  const longSentence = 'слово '.repeat(80).trim() // длинное предложение без переносов
  const s = serializeMd({ context: longSentence }, 'тело\n')
  // lineWidth: -1 в serializeMd отключает перенос строк — вся строка обязана остаться в одной строке YAML
  const yamlLines = s.split('\n')
  const contextLine = yamlLines.find(l => l.startsWith('context:'))
  assert(!!contextLine, 'поле context должно попасть в вывод')
  assert(contextLine!.includes(longSentence), 'длинная строка не должна переноситься на несколько строк YAML')
  const { fm: fm2 } = parseMd(s)
  assert(fm2.context === longSentence, 'длинная строка без переноса должна пережить круг без изменений')
  group('serializeMd: длинные строки не переносятся (lineWidth:-1) и переживают круг')
}

function fmNbspChecks(): void {
  // неразрывный пробел (U+00A0) — из настоящих карточек ("не ______" на грани строки)
  const withNbsp = `слово\u00A0в контексте с неразрывным\u00A0пробелом`
  const s = serializeMd({ context: withNbsp }, 'тело\n')
  const { fm: fm2, broken } = parseMd(s)
  assert(!broken, 'НБСП не должен ломать разбор')
  assert(fm2.context === withNbsp, 'неразрывный пробел должен пережить круг байт-в-байт (экранирование \\_ в YAML)')
  assert(fm2.context.includes('\u00A0'), 'после разбора символ обязан остаться настоящим НБСП, а не обычным пробелом')
  group('serializeMd/parseMd: экранирование неразрывного пробела переживает круг')
}

function fmKatexChecks(): void {
  // формулы попадают в текст, который YAML вынужден заключить в кавычки (двоеточие с пробелом —
  // тот же триггер, что в реальных contexts_ru карточек, например у corroborate.md)
  const formulas = ['$\\frac{1}{2}$', '$\\times$', '$\\le$']
  for (const f of formulas) {
    const value = `Условие: реши уравнение ${f} и назови корень, не забыв про x`
    const s = serializeMd({ explain: value }, 'тело\n')
    const { fm: fm2, broken } = parseMd(s)
    assert(!broken, `формула ${f}: не должна ломать разбор`)
    assert(fm2.explain === value, `формула ${f} обязана пережить круг без искажения бэкслэшей`)
    const s2 = serializeMd(fm2, 'тело\n')
    assert(s2 === s, `формула ${f}: повторная сериализация обязана быть побайтово стабильной`)
  }
  group('serializeMd/parseMd: формулы KaTeX в кавычках, вынужденных YAML (\\frac, \\times, \\le), не портятся')
}

function fmStabilityChecks(): void {
  const fixtures: Record<string, any>[] = [
    { word: 'abstract', level: 1 },
    { word: 'тест', context: 'a\u00A0b', explain: 'if x > 1: y', my_sentence: "it's a $\\times$ test" },
    { fsrs: { state: 0, due: '2026-01-01T00:00:00.000Z', stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, last_review: null } }
  ]
  for (const fm of fixtures) {
    const s1 = serializeMd(fm, 'тело\n')
    const { fm: fm2, body: body2 } = parseMd(s1)
    const s2 = serializeMd(fm2, body2)
    assert(s2 === s1, `повторная сериализация ${JSON.stringify(fm)} должна быть побайтово равна первой`)
  }
  group('serializeMd: повторная сериализация побайтово равна первой (стабильность) на разных фикстурах')
}

// ---- mergeCard: зоны владения ----------------------------------------------

function mergeCardBaseChecks(): void {
  const remote = { fm: { word: 'изменено тьютором', tutor_note: 'заметка тьютора' }, body: 'новое тело от тьютора' }
  const local = localCard({ word: 'старое', tutor_note: 'старая заметка', fsrs: { reps: 5, state: 2 }, my_sentence: 'моё предложение', junk: 'локальный мусор без владельца' })
  const m = mergeCard(remote, local)
  assert(m.fm.word === 'изменено тьютором', 'удалённый frontmatter берётся как база — правку тьютора нельзя перетирать')
  assert(m.fm.tutor_note === 'заметка тьютора', 'чужие поля тьютора должны сохраниться целиком, а не браться из локальной версии')
  assert(m.fm.fsrs.reps === 5 && m.fm.fsrs.state === 2, 'блок fsrs берётся из локальной версии (приложение — единственный источник)')
  assert(m.fm.my_sentence === 'моё предложение', 'my_sentence берётся из локальной версии')
  assert(m.fm.junk === undefined, 'поля, которыми приложение не владеет, из локальной версии не переносятся')
  assert(m.body === 'новое тело от тьютора', 'тело файла всегда берётся удалённое')
  group('mergeCard: удалённый frontmatter — база, чужие поля сохраняются, fsrs/my_sentence — из локальной версии, body — всегда удалённое')
}

function mergeCardPrepChecks(): void {
  // remote потерял prep-поля (тьютор снял подготовку) — fsrs_prep из локальной версии НЕ переносится,
  // даже если у локальной карточки prep/prep_context ещё стоят
  const remoteWithoutPrep = { fm: { word: 'x' }, body: 'b' }
  const localWithPrep = localCard({ prep: 'p', prep_context: 'ctx', fsrs_prep: { reps: 3, state: 2 } })
  const mLost = mergeCard(remoteWithoutPrep, localWithPrep)
  assert(mLost.fm.fsrs_prep === undefined, 'fsrs_prep не переносится, если у карточки (после слияния) нет prep+prep_context')

  // remote сохранил prep-поля — fsrs_prep из локальной версии переносится
  const remoteWithPrep = { fm: { word: 'x', prep: 'p', prep_context: 'ctx' }, body: 'b' }
  const mKept = mergeCard(remoteWithPrep, localWithPrep)
  assert(mKept.fm.fsrs_prep && mKept.fm.fsrs_prep.reps === 3, 'fsrs_prep переносится, пока у карточки есть prep и prep_context')
  group('mergeCard: fsrs_prep сохраняется только пока у карточки есть поля prep и prep_context')
}

function mergeCardFirstSeenChecks(): void {
  // reps > 0 — first_seen подтягивается
  const rated = localCard({ first_seen: '2026-01-01', fsrs: { reps: 5, state: 2 } })
  const m1 = mergeCard({ fm: { word: 'x' }, body: 'b' }, rated)
  assert(m1.fm.first_seen === '2026-01-01', 'first_seen подтягивается у карточки с reps > 0')

  // reps === 0 (знакомство без единой оценки) — first_seen НЕ подтягивается
  const unrated = localCard({ first_seen: '2026-01-01', fsrs: { reps: 0, state: 0 } })
  const m2 = mergeCard({ fm: { word: 'x' }, body: 'b' }, unrated)
  assert(m2.fm.first_seen === undefined, 'first_seen не подтягивается у карточки без единой оценки (reps=0)')

  // у удалённой версии first_seen уже есть — своя (более ранняя/чужая) дата не перезаписывается
  const m3 = mergeCard({ fm: { word: 'x', first_seen: '2025-06-01' }, body: 'b' }, rated)
  assert(m3.fm.first_seen === '2025-06-01', 'уже стоящий в удалённой версии first_seen не перезаписывается локальным')
  group('mergeCard: first_seen подтягивается только у карточки с reps > 0 и только если в удалённой версии его ещё нет')
}

// ---- toNdjson/parseNdjson: журнал ------------------------------------------

function journalRoundtripChecks(): void {
  const lines: JournalLine[] = [
    line({ id: 'a', type: 'review', format: 'type', correct: true, elapsed_ms: 4200, level: 3, domain: 'II' }),
    line({ id: 'b', type: 'session', dur_ms: 90000, reviews: 12, acc: 80, acc_all: 75, queue_empty: true }),
    line({ id: 'c', type: 'read', read_min: 25, what: 'глава 3' })
  ]
  const text = toNdjson(lines)
  const { lines: parsed, rejects } = parseNdjson(text)
  assert(rejects.length === 0, 'валидные строки не должны попадать в rejects')
  assert(parsed.length === lines.length, 'круговой обход не должен терять строки')
  for (const orig of lines) {
    const back = parsed.find(l => l.id === orig.id)
    assert(!!back, `строка ${orig.id} должна найтись после круга`)
    assert(JSON.stringify(back) === JSON.stringify(orig), `строка ${orig.id} должна пережить круг без потери и без искажения полей`)
  }

  // синк-флаг synced — служебный для этого устройства, в общий файл журнала не пишется (сознательно)
  const synced: JournalRec = { ...line({ id: 'd' }), synced: 1 }
  const text2 = toNdjson([synced])
  const { lines: parsed2 } = parseNdjson(text2)
  assert((parsed2[0] as any).synced === undefined, 'поле synced не должно попадать в записанный файл журнала')
  group('toNdjson/parseNdjson: круговой обход строк разных типов (review/session/read) без потери полей')
}

function journalDedupChecks(): void {
  // Дедупликация по id в реальном пайплайне держится на IndexedDB (object store 'journal',
  // keyPath: 'id' — см. src/lib/db.ts): put с тем же id перезаписывает запись, а не дублирует.
  // Здесь та же семантика «последний put выигрывает» воспроизведена через Map — это ЧЕСТНАЯ
  // модель реального контракта хранилища, а не подмена: toNdjson/parseNdjson сами по себе
  // не дедуплицируют вход, дедупликация — контракт объектного хранилища выше по стеку.
  const raw = [
    line({ id: 'x', rating: 1 }),
    line({ id: 'y', rating: 3 }),
    line({ id: 'x', rating: 4 }) // повторная запись той же строки (id 'x') с новым исходом
  ]
  const byId = new Map<string, JournalLine>()
  for (const l of raw) byId.set(l.id, l) // «put» — последний побеждает, как в IndexedDB
  const deduped = [...byId.values()]
  assert(deduped.length === 2, 'после put с повторным id в хранилище должно остаться 2 записи, не 3')

  const text = toNdjson(deduped)
  const { lines: parsed } = parseNdjson(text)
  assert(parsed.length === 2, 'файл месяца не должен содержать дублей по id')
  const x = parsed.find(l => l.id === 'x')!
  assert(x.rating === 4, 'при дедупликации должна остаться последняя версия записи (rating=4), а не первая')
  group('toNdjson/parseNdjson: дедупликация по id при объединении (put keyPath:id — последний побеждает)')
}

function journalMonthFilterChecks(): void {
  // Тот же приём, что в src/lib/sync.ts (doSync): journal.filter(j => monthOfDay(j.day) === mo)
  // перед toNdjson — фильтрация месяца делается ВЫЗЫВАЮЩИМ кодом через чистую monthOfDay,
  // а не внутри toNdjson. Здесь воспроизведён этот же однострочный пайплайн реальными функциями.
  const lines: JournalLine[] = [
    line({ id: 'jul-1', day: '2026-07-15', ts: '2026-07-15T10:00:00+03:00' }),
    line({ id: 'jul-2', day: '2026-07-20', ts: '2026-07-20T10:00:00+03:00' }),
    line({ id: 'aug-1', day: '2026-08-01', ts: '2026-08-01T10:00:00+03:00' })
  ]
  const julyOnly = lines.filter(l => monthOfDay(l.day) === '2026-07')
  assert(julyOnly.length === 2, 'setup: monthOfDay должен отобрать 2 июльские строки')

  const text = toNdjson(julyOnly)
  const { lines: parsed } = parseNdjson(text)
  assert(parsed.length === 2, 'в файле месяца должны остаться только его строки')
  assert(parsed.every(l => monthOfDay(l.day) === '2026-07'), 'строки чужого месяца не должны попасть в файл месяца')
  assert(!parsed.some(l => l.id === 'aug-1'), 'августовская строка не должна оказаться в июльском файле')
  group('toNdjson/parseNdjson: строки чужого месяца не попадают в файл месяца (пайплайн monthOfDay → toNdjson)')
}

function journalBrokenLineChecks(): void {
  const good1 = line({ id: 'good-1' })
  const good2 = line({ id: 'good-2' })
  const text = [
    JSON.stringify(good1),
    '{это не валидный json',                       // битый JSON
    JSON.stringify({ id: 'no-day', ts: '2026-07-01T00:00:00+03:00' }), // валидный JSON, но без обязательного day
    '',                                              // пустая строка — пропускается молча, не reject
    JSON.stringify(good2)
  ].join('\n')

  const { lines, rejects } = parseNdjson(text)
  assert(lines.length === 2, `битая строка не должна ронять разбор остальных: ожидалось 2 валидные, получено ${lines.length}`)
  assert(lines.some(l => l.id === 'good-1') && lines.some(l => l.id === 'good-2'), 'обе валидные строки должны разобраться')
  assert(rejects.length === 2, `битый JSON и строка без day должны попасть в rejects, получено ${rejects.length}`)

  // reject-строки сохраняются как есть (raw), не теряются — тот же путь, что rawByMonth в sync.ts
  const rewritten = toNdjson(lines, rejects)
  const { lines: lines2, rejects: rejects2 } = parseNdjson(rewritten)
  assert(lines2.length === 2 && rejects2.length === 2, 'битые строки должны пережить повторную запись как сырые (rawExtras), не пропадая и не мешая валидным')
  group('parseNdjson: битая строка (плохой JSON, отсутствие обязательных полей) не роняет разбор остальных строк файла')
}

// ---- cardTimeCap: потолок зачётного времени --------------------------------

function cardTimeCapChecks(): void {
  assert(CARD_TIME_CAP_MS === 60_000, `CARD_TIME_CAP_MS ожидалось 60000, получено ${CARD_TIME_CAP_MS}`)
  assert(cardTimeCap('math') === 180_000, `math-карточка: ожидалось 180000, получено ${cardTimeCap('math')}`)
  assert(cardTimeCap('vocab') === CARD_TIME_CAP_MS, `обычная карточка: ожидалось ${CARD_TIME_CAP_MS}, получено ${cardTimeCap('vocab')}`)
  assert(cardTimeCap(undefined) === CARD_TIME_CAP_MS, `карточка без kind: ожидалось ${CARD_TIME_CAP_MS}, получено ${cardTimeCap(undefined)}`)
  group('cardTimeCap: потолок 60 с для обычной карточки, 180 с для математики')
}

// ---- db.ts: чистые функции (hasRatedFsrs, MassDeleteError) -----------------

function hasRatedFsrsChecks(): void {
  assert(hasRatedFsrs({}) === false, 'без fsrs-блока — false')
  assert(hasRatedFsrs({ fsrs: { reps: 0 } }) === false, 'reps=0 (знакомство без оценки) — false')
  assert(hasRatedFsrs({ fsrs: { reps: 5 } }) === true, 'reps>0 — true')
  assert(hasRatedFsrs({ fsrs: { reps: '5' } }) === true, 'reps числовой строкой — приводится и считается')
  assert(hasRatedFsrs({ fsrs: 'битый-не-объект' }) === false, 'fsrs не объект — false, не бросает исключение')
  assert(hasRatedFsrs({ fsrs: null }) === false, 'fsrs=null — false')
  group('db.hasRatedFsrs: слово с оценкой (reps>0 в объекте fsrs) отличается от знакомства и от битых данных')
}

function massDeleteErrorChecks(): void {
  const пути = ['Учёба/Карточки/bolster.md', 'Учёба/Карточки/deter.md']
  const e = new MassDeleteError(15, 60, пути)
  assert(e instanceof Error, 'MassDeleteError обязан быть Error (иначе try/catch по e instanceof Error его не поймает)')
  assert(e.count === 15 && e.total === 60, 'count/total должны сохраниться как переданы')
  assert(e.paths === пути, 'paths должны сохраниться: без имён файлов предупреждение не назовёт, что именно собирались удалить')
  assert(e.message === 'mass delete: 15/60', `сообщение должно называть числа явно, получено "${e.message}"`)
  group('db.MassDeleteError: несёт count/total/paths и человекочитаемое сообщение, остаётся instanceof Error')
}

// ---- живая колода (необязательно) ------------------------------------------

const DECK_DIR = 'C:/Users/sasha/dev/sat-deck/Учёба/Карточки'

function liveDeckChecks(): void {
  if (!existsSync(DECK_DIR)) {
    skip(`живая колода не найдена (${DECK_DIR}) — группа пропущена, это не эта машина`)
    return
  }
  const files = readdirSync(DECK_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'))
  assert(files.length > 0, 'в живой колоде должны быть карточки')

  let broken = 0
  for (const f of files) {
    const text = readFileSync(path.join(DECK_DIR, f), 'utf8')
    const { fm, body, broken: b } = parseMd(text)
    if (b) { broken++; continue }
    const s1 = serializeMd(fm, body)
    const { fm: fm2, body: body2, broken: b2 } = parseMd(s1)
    assert(!b2, `${f}: повторный разбор не должен ломаться`)
    assert(JSON.stringify(fm2) === JSON.stringify(fm), `${f}: frontmatter должен пережить круг без дрейфа`)
    assert(body2 === body, `${f}: тело должно пережить круг без изменений`)
    const s2 = serializeMd(fm2, body2)
    assert(s2 === s1, `${f}: повторная сериализация должна быть побайтово стабильна`)
  }
  assert(broken === 0, `все ${files.length} карточек живой колоды должны валидно разбираться, битых: ${broken}`)
  console.log(`  ⓘ живая колода: ${files.length} карточек, круговой обход без потерь и дрейфа`)

  const journalDir = path.join(DECK_DIR, '_журнал')
  const monthFiles = existsSync(journalDir)
    ? readdirSync(journalDir).filter(f => /^\d{4}-\d{2}\.ndjson$/.test(f))
    : []
  let totalLines = 0
  let totalRejects = 0
  for (const jf of monthFiles) {
    const text = readFileSync(path.join(journalDir, jf), 'utf8')
    const { lines, rejects } = parseNdjson(text)
    totalLines += lines.length
    totalRejects += rejects.length
    const out = toNdjson(lines)
    const { lines: lines2, rejects: rejects2 } = parseNdjson(out)
    assert(lines2.length === lines.length, `${jf}: круговой обход журнала не должен терять строки`)
    assert(rejects2.length === 0, `${jf}: круговой обход не должен порождать новые битые строки`)
  }
  assert(totalRejects === 0, `битых строк в живом журнале быть не должно, найдено: ${totalRejects}`)
  console.log(`  ⓘ живой журнал: ${monthFiles.length} месячных файлов, ${totalLines} строк, круговой обход без потерь`)

  group('живая колода: parseMd/serializeMd на всех карточках и toNdjson/parseNdjson на всех месячных файлах — без потерь и дрейфа')
}

function main(): void {
  console.log('Слой данных — yamlfm/journal/db: круговые обходы и зоны владения')
  fmRoundtripChecks()
  fmUnicodeChecks()
  fmLongLineChecks()
  fmNbspChecks()
  fmKatexChecks()
  fmStabilityChecks()
  mergeCardBaseChecks()
  mergeCardPrepChecks()
  mergeCardFirstSeenChecks()
  journalRoundtripChecks()
  journalDedupChecks()
  journalMonthFilterChecks()
  journalBrokenLineChecks()
  cardTimeCapChecks()
  hasRatedFsrsChecks()
  massDeleteErrorChecks()
  liveDeckChecks()
  console.log(`\nВсе проверки слоя данных пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ СЛОЯ ДАННЫХ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
