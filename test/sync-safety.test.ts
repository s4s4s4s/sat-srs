/**
 * Тесты слоя данных: слияние устройств, подтверждение push-а, предохранитель удаления,
 * атомарность оценки, потолок времени, зажим срока под DUE_CAP и флаг «Пиявка».
 *
 * Все семь проверяемых здесь дефектов объединяет одно: каждый молча терял работу ученика и
 * не показывался ни на одном экране. Поэтому тесты идут по правилам, а не по симптомам, —
 * и там, где правило было чистой функцией внутри rateItem/applyPull, оно вынесено наружу
 * (clampDueBeforeCap, leechTransition, deletionPlan, journalUnchanged), чтобы его можно было
 * проверить исполнением, а не чтением.
 *
 * Чего здесь НЕТ и не может быть: сама транзакционность IndexedDB и сетевой цикл sync.
 * В node нет ни IndexedDB, ни GitHub, и подделка того и другого проверяла бы подделку.
 * Для двух мест, где правило неотделимо от места вызова (оценка пишется одной транзакцией;
 * потолок времени применён именно при записи строки), стоит структурная проверка исходника —
 * она честно названа структурной и ловит возврат старого кода, но не заменяет живой прогон.
 *
 * Живая колода (../sat-deck) подключается, если лежит рядом: настоящие карточки и настоящий
 * журнал — единственный способ увидеть, что правило встречает в реальных данных, а не в фабриках.
 * Её отсутствие (облачная сессия, чужая машина) не роняет прогон, но и не проходит молча —
 * тест говорит об этом строкой в выводе, и синтетические группы покрывают все семь правил сами.
 *
 * Запуск: esbuild бандлит файл и node его исполняет (см. package.json, соседние test:*).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { State, type Card as FsrsCard } from 'ts-fsrs'
import { parseMd, mergeCard, pickFsrsBlock } from '../src/lib/yamlfm'
import {
  deletionPlan, massDeleteConfirmed, massDeleteNeedsConfirm, journalUnchanged, nfcPath,
  MASS_DELETE_CONFIRM_MS, MassDeleteError, type MassDeletePending
} from '../src/lib/db'
import { isCardPath, isJournalPath, massDeleteMessage } from '../src/lib/sync'
import { clampDueBeforeCap, journalElapsedMs, leechTransition } from '../src/lib/store'
import { DUE_CAP } from '../src/lib/scheduler'
import { cardTimeCap } from '../src/lib/journal'
import { isLeech, LEECH_STABILITY_DAYS } from '../src/lib/metrics'
import { endOfStudyDay } from '../src/lib/daytime'
import type { CardRec, JournalRec } from '../src/lib/types'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

const DAY = 86400_000

/* Путь к исходникам и к живой колоде строим от cwd — так же, как test/math-pilot.test.ts:
   бандл лежит в node_modules/.cache, и import.meta.url внутри него указывал бы на кэш. */
const SRC = path.join(process.cwd(), 'src', 'lib')
const DECK_DIR = process.env.SAT_DECK ?? path.join(process.cwd(), '..', 'sat-deck', 'Учёба', 'Карточки')

function source(file: string): string {
  const p = path.join(SRC, file)
  assert(existsSync(p), `не найден исходник ${p} — тест запускают из корня пакета`)
  // git отдаёт рабочее дерево с CRLF (core.autocrlf), а искать по исходнику проще в одном виде
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

/** Тело функции по её заголовку: от строки объявления до закрывающей скобки в нулевой колонке. */
function funcBody(src: string, header: string): string {
  const i = src.indexOf(header)
  assert(i >= 0, `в исходнике не найдено объявление «${header}» — тест устарел или функцию переименовали`)
  const j = src.indexOf('\n}\n', i)
  assert(j > i, `не найден конец функции «${header}»`)
  return src.slice(i, j)
}

// ---- фабрики -------------------------------------------------------------

/** fsrs-блок в том виде, в каком он лежит во frontmatter файла (даты — строки). */
function block(o: { reps: number; stability: number; last_review: string | Date | null; state?: number }): Record<string, any> {
  return {
    state: o.state ?? 2,
    due: '2026-09-01T10:00:00.000Z',
    stability: o.stability,
    difficulty: 6,
    elapsed_days: 3,
    scheduled_days: 5,
    learning_steps: 0,
    reps: o.reps,
    lapses: 0,
    last_review: o.last_review
  }
}

function cardRec(fm: Record<string, any>, over: Partial<CardRec> = {}): CardRec {
  return { path: 'Учёба/Карточки/abstract.md', sha: 'aaa', fm, body: '', dirty: 1, ...over }
}

function fsrs(o: Partial<FsrsCard>): FsrsCard {
  return {
    due: new Date('2026-10-20T00:00:00.000Z'), stability: 30, difficulty: 6, elapsed_days: 0,
    scheduled_days: 0, learning_steps: 0, reps: 5, lapses: 0, state: State.Review,
    last_review: new Date('2026-09-01T00:00:00.000Z'), ...o
  }
}

const journalLine = (o: Partial<JournalRec> = {}): JournalRec => ({
  id: 'j-1', v: 1, type: 'review', ts: '2026-08-21T10:00:00+04:00', ms: 120, day: '2026-08-21',
  slug: 'abstract', skill: 'recall', format: 'mc', correct: false, rating: 1, synced: 0, ...o
})

// ---- 1. Слияние двух устройств -------------------------------------------

function mergeChecks(): void {
  /* Воспроизведение из аудита: телефон отправил reps=8 при стабильности 30.18, ноутбук без
     сети записал свой повтор поверх старой базы и пришёл с reps=6 и стабильностью 25.0. */
  const remote = { fm: { word: 'abstract', fsrs: block({ reps: 8, stability: 30.18, last_review: '2026-08-20T19:28:37.795Z' }) }, body: 'тело от тьютора' }
  const local = cardRec({ word: 'abstract', fsrs: block({ reps: 6, stability: 25.0, last_review: '2026-08-18T09:00:00.000Z' }) })
  const merged = mergeCard(remote, local)
  assert(merged.fm.fsrs.reps === 8 && merged.fm.fsrs.stability === 30.18,
    `свежий удалённый блок должен победить, получено reps=${merged.fm.fsrs.reps} stability=${merged.fm.fsrs.stability}`)
  assert(merged.body === 'тело от тьютора', 'тело файла остаётся удалённым — его владелец тьютор')

  // обратное направление: локальная оценка новее — побеждает она, иначе слияние съедало бы свежий повтор
  const localFresh = cardRec({ fsrs: block({ reps: 9, stability: 31, last_review: '2026-08-21T12:00:00.000Z' }) })
  assert(mergeCard(remote, localFresh).fm.fsrs.reps === 9, 'более свежий локальный блок должен победить')
  group('слияние: побеждает блок с более свежим last_review, а не локальный по умолчанию')

  // равный момент повтора — решает число повторов
  const same = '2026-08-20T19:28:37.795Z'
  assert(pickFsrsBlock(block({ reps: 8, stability: 30, last_review: same }), block({ reps: 6, stability: 25, last_review: same })).reps === 8,
    'при равном last_review побеждает больший reps')
  // тот же момент, записанный в другом поясе и другим типом: сравнение идёт по абсолютному времени
  const tz = pickFsrsBlock(
    block({ reps: 4, stability: 10, last_review: '2026-08-20T23:28:37.795+04:00' }),
    block({ reps: 7, stability: 12, last_review: new Date('2026-08-20T19:28:37.795Z') })
  )
  assert(tz.reps === 7, `пояс и тип не должны решать за содержимое: получено reps=${tz.reps}`)
  group('слияние: равенство моментов разводится по reps, пояс и тип даты не влияют')

  // карточка, которую ни разу не оценивали, не может описывать более позднее состояние
  const neverRated = block({ reps: 0, stability: 0, last_review: null })
  const rated = block({ reps: 3, stability: 4, last_review: '2026-08-10T10:00:00.000Z' })
  assert(pickFsrsBlock(neverRated, rated).reps === 3, 'локальный оценённый блок побеждает удалённый неоценённый')
  assert(pickFsrsBlock(rated, neverRated).reps === 3, 'удалённый оценённый блок побеждает локальный неоценённый')
  // блока нет вовсе (тьютор переписал файл) — берём тот, что есть
  assert(pickFsrsBlock(undefined, rated) === rated, 'при отсутствии удалённого блока остаётся локальный')
  assert(pickFsrsBlock(rated, undefined) === rated, 'при отсутствии локального блока остаётся удалённый')
  assert(pickFsrsBlock(undefined, undefined) === undefined, 'нет ни одного блока — нечего и записывать')
  group('слияние: краевые случаи last_review (нет оценок, нет блока)')

  // fsrs_prep — своя история повторов, и тот же розыгрыш
  const rp = { fm: { prep: 'to', prep_context: 'ctx', fsrs_prep: block({ reps: 5, stability: 9, last_review: '2026-08-20T10:00:00.000Z' }) }, body: '' }
  const lp = cardRec({ prep: 'to', prep_context: 'ctx', fsrs_prep: block({ reps: 3, stability: 4, last_review: '2026-08-12T10:00:00.000Z' }) })
  assert(mergeCard(rp, lp).fm.fsrs_prep.reps === 5, 'fsrs_prep сливается по тому же правилу, что и fsrs')
  // prep-поля сняты тьютором — навыка больше нет, локальный fsrs_prep не воскрешаем
  const noPrep = mergeCard({ fm: { word: 'abstract' }, body: '' }, lp)
  assert(noPrep.fm.fsrs_prep === undefined, 'снятые prep-поля не должны тянуть за собой старый fsrs_prep')
  group('слияние: fsrs_prep по тому же правилу и только пока жив сам навык')

  // соседнее правило про first_seen не сломано
  const withSeen = cardRec({ first_seen: '2026-07-17', fsrs: block({ reps: 4, stability: 5, last_review: '2026-08-19T10:00:00.000Z' }) })
  assert(mergeCard({ fm: { word: 'w' }, body: '' }, withSeen).fm.first_seen === '2026-07-17', 'first_seen оценённого слова подтягивается')
  const seenUnrated = cardRec({ first_seen: '2026-07-17', fsrs: block({ reps: 0, stability: 0, last_review: null }) })
  assert(mergeCard({ fm: { word: 'w' }, body: '' }, seenUnrated).fm.first_seen === undefined, 'first_seen неоценённого слова не возвращается')
  group('слияние: правило first_seen (только у слова с reps > 0) не задето')
}

// ---- 2. Самоотчёт «почему ошибся» ----------------------------------------

function journalPushChecks(): void {
  const pushed = journalLine()
  assert(journalUnchanged({ ...pushed }, pushed), 'копия строки — та же строка')
  // порядок ключей не должен решать за содержимое: IndexedDB отдаёт объект своей сборки
  const { id, synced: было, ...rest } = pushed
  void было
  const reordered = { synced: 1, ...rest, id } as JournalRec
  assert(journalUnchanged(reordered, pushed), 'перестановка ключей не делает строку изменившейся')
  assert(journalUnchanged({ ...pushed, synced: 1 }, pushed), 'служебный synced в сравнение не входит')

  /* Дефект: ученик выбирает причину ошибки во время push-а (setCause дописывает `cause`
     в ту же строку). По снимку строка помечалась отправленной, причина затиралась и не
     уезжала уже никогда. Теперь такая строка отправленной не считается. */
  const withCause = { ...pushed, cause: 'слово' }
  assert(!journalUnchanged(withCause, pushed), 'строка с дописанной причиной не должна считаться отправленной')
  assert(!journalUnchanged(undefined, pushed), 'исчезнувшая строка отправленной не считается')
  assert(!journalUnchanged({ ...pushed, rating: 3 }, pushed), 'изменённая оценка не считается отправленной')
  group('журнал: `synced` снимается только с неизменившейся строки (причина ошибки не затирается)')

  // структурная: снимок `unsynced` больше не штампуется целиком
  const sync = source('sync.ts')
  assert(sync.includes('db.confirmJournalPushed(unsynced)'), 'sync.ts должен подтверждать журнал через confirmJournalPushed')
  assert(!/putJournal\(unsynced\.map/.test(sync), 'sync.ts не должен помечать журнал по устаревшему снимку')
  group('журнал (структурно): sync.ts подтверждает строки по свежей записи, а не по снимку')
}

// ---- 3. Предохранитель массового удаления --------------------------------

function massDeleteChecks(): void {
  const base = 'Учёба/Карточки'
  const local = [
    { path: `${base}/a.md`, dirty: 0, sha: 'x' },
    { path: `${base}/b.md`, dirty: 1, sha: 'y' },   // есть в repo, но с неотправленной оценкой
    { path: `${base}/c.md`, dirty: 1, sha: null },  // ни разу не отправленная новая
    { path: `${base}/d.md`, dirty: 0, sha: 'z' }
  ]
  const plan = deletionPlan(local, new Set<string>())
  assert(plan.length === 2 && plan.includes(`${base}/a.md`) && plan.includes(`${base}/d.md`),
    `удалять можно только чистые карточки, получено: ${plan.join(', ') || '—'}`)
  assert(!plan.includes(`${base}/b.md`), 'карточка с неотправленной оценкой не удаляется, даже имея sha')
  assert(deletionPlan(local, local.map(c => c.path)).length === 0, 'ничего не удаляем, пока файлы на месте')
  group('удаление: карточка с неотправленными изменениями не удаляется независимо от sha')

  /* Латентная ловушка: путь из macOS приходит в NFD. Те же буквы, другие байты — и раньше
     колода целиком уходила в удаление, потому что ни один путь не совпадал. */
  const nfd = local.map(c => c.path.normalize('NFD'))
  assert(nfd[0] !== local[0].path, 'проверка бессмысленна, если формы совпали: в пути нет кириллицы')
  assert(deletionPlan(local, nfd).length === 0, 'NFD-форма пути из repo не должна выглядеть исчезнувшим файлом')
  assert(isCardPath(`${base}/abstract.md`.normalize('NFD'), base), 'карточка в NFD обязана опознаваться карточкой')
  assert(!isCardPath(`${base}/_журнал/2026-08.ndjson`.normalize('NFD'), base), 'файл журнала в NFD не карточка')
  assert(isJournalPath(`${base}/_журнал/2026-08.ndjson`.normalize('NFD'), base), 'журнал в NFD обязан опознаваться журналом')
  assert(!isJournalPath(`${base}/_журнал/_метрики.ndjson`.normalize('NFD'), base), 'служебные `_`-файлы журналом не считаются')
  assert(nfcPath('й'.normalize('NFD')) === 'й', 'nfcPath приводит разложенную форму к составной')
  group('удаление: пути сравниваются в канонической форме — NFD-колода не выглядит удалённой')

  // порог предохранителя не тронут: много И заметная доля
  assert(massDeleteNeedsConfirm(11, 50), '11 из 50 — обвал, нужно подтверждение')
  assert(!massDeleteNeedsConfirm(10, 12), '10 карточек — под порогом штуки')
  assert(!massDeleteNeedsConfirm(11, 100), '11 из 100 — под порогом доли')

  /* Подтверждение помнит СОСТАВ. Прежде это был голый таймстемп, и повторное нажатие Синка —
     естественная реакция на ошибку — удаляло вслепую всё, что успело набежать. */
  const paths = [`${base}/a.md`, `${base}/d.md`]
  const now = Date.now()
  const pending: MassDeletePending = { ts: now, paths }
  assert(massDeleteConfirmed(pending, [...paths].reverse(), now + 1000), 'тот же состав подтверждён, порядок значения не имеет')
  assert(massDeleteConfirmed(pending, paths.map(p => p.normalize('NFD')), now + 1000), 'состав сверяется в канонической форме')
  assert(!massDeleteConfirmed(pending, [...paths, `${base}/e.md`], now + 1000), 'добавился файл — подтверждение недействительно')
  assert(!massDeleteConfirmed(pending, [paths[0]], now + 1000), 'состав уменьшился — подтверждение недействительно')
  assert(!massDeleteConfirmed(pending, paths, now + MASS_DELETE_CONFIRM_MS + 1), 'просроченное подтверждение не действует')
  assert(!massDeleteConfirmed(pending, paths, now - 1000), 'подтверждение «из будущего» (съехали часы) не действует')
  assert(!massDeleteConfirmed(now, paths, now), 'подтверждение старого формата (голый таймстемп) не принимается')
  assert(!massDeleteConfirmed(null, paths, now), 'без подтверждения удаление не разрешено')
  group('удаление: подтверждение привязано к списку путей и живёт 10 минут')

  const msg = massDeleteMessage(new MassDeleteError(12, 468, Array.from({ length: 12 }, (_, i) => `${base}/слово-${i}.md`)))
  assert(msg.includes('12') && msg.includes('468'), 'текст обязан называть, сколько карточек из скольких')
  assert(msg.includes('слово-0.md') && msg.includes('слово-9.md') && msg.includes('и ещё 2'), 'текст обязан называть сами файлы')
  assert(!/нажмите Синк ещё раз/i.test(msg), 'текст не должен звать нажать кнопку повторно как реакцию на ошибку')
  assert(msg.includes('не удалено ничего'), 'текст обязан сказать, что колода цела')
  group('удаление: предупреждение называет число и файлы, а не зовёт нажать кнопку ещё раз')
}

// ---- 4. Атомарность оценки (структурно) ----------------------------------

function atomicityChecks(): void {
  const rate = funcBody(source('store.ts'), 'export async function rateItem(')
  assert(rate.includes('db.putCardAndJournal('), 'rateItem обязан писать карточку и строку журнала одним вызовом')
  assert(!/await db\.putCard\(/.test(rate), 'rateItem не должен писать карточку отдельной транзакцией')
  assert(!/await db\.putJournal\(/.test(rate), 'rateItem не должен писать журнал отдельной транзакцией')

  const put = funcBody(source('db.ts'), 'export async function putCardAndJournal(')
  assert(/transaction\(\[['"]cards['"], ?['"]journal['"]\]/.test(put), 'putCardAndJournal обязан открывать одну транзакцию на два хранилища')
  assert((put.match(/\.transaction\(/g) ?? []).length === 1, 'транзакция должна быть ровно одна')
  group('оценка (структурно): карточка и строка журнала пишутся одной транзакцией на два хранилища')
}

// ---- 5. Потолок времени в журнале ----------------------------------------

function elapsedChecks(): void {
  assert(journalElapsedMs(4_300) === 4_300, 'обычный замер проходит как есть')
  assert(journalElapsedMs(20 * 60_000) === cardTimeCap(), `замер за потолком зажимается: ${journalElapsedMs(20 * 60_000)}`)
  assert(journalElapsedMs(120_000, 'math') === 120_000, 'математике потолок выше (180 c) — две минуты в него укладываются')
  assert(journalElapsedMs(120_000) === cardTimeCap(), 'те же две минуты на слове — уже за потолком')
  assert(journalElapsedMs(20 * 60_000, 'math') === cardTimeCap('math'), 'но и математический потолок работает')
  assert(journalElapsedMs(cardTimeCap()) === cardTimeCap(), 'ровно потолок остаётся собой')
  assert(journalElapsedMs(-5) === 0 && journalElapsedMs(NaN) === 0, 'отрицательный и нечисловой замер — это ноль, а не мусор в журнале')
  group('время: потолок cardTimeCap применяется к значению, которое уходит в журнал')

  const rate = funcBody(source('store.ts'), 'export async function rateItem(')
  assert(/elapsed_ms: journalElapsedMs\(/.test(rate), 'строка журнала обязана писать зажатый замер, а не сырой elapsedMs')
  group('время (структурно): rateItem пишет elapsed_ms через journalElapsedMs')
}

// ---- 6. Зажим срока под DUE_CAP ------------------------------------------

/** Прежняя формула — для доказательства, что дефект был, а не показался. */
function oldClamp(next: FsrsCard, now: Date, rnd: number): Date {
  const span = Math.min(14, Math.max(5, Math.round(next.stability / 10)))
  return new Date(DUE_CAP.getTime() - Math.floor(rnd * span) * DAY)
}

function dueCapChecks(): void {
  const now = new Date(2026, 8, 24, 10, 0, 0)      // 24.09.2026, замер из аудита
  const strong = fsrs({ stability: 120, due: new Date(2027, 0, 20) })

  let inPast = 0
  for (let i = 0; i < 200; i++) if (oldClamp(strong, now, i / 200) <= now) inPast++
  assert(inPast > 100, `прежняя формула обязана давать сроки в прошлом (иначе нечего чинить), получено ${inPast} из 200`)

  for (let i = 0; i < 200; i++) {
    const r = clampDueBeforeCap(strong, now, DUE_CAP, () => i / 200)
    assert(r.due > now, `срок ${r.due.toISOString()} не должен быть в прошлом или сегодня-в-прошлом`)
    assert(r.due >= endOfStudyDay(now), 'срок не должен возвращать карточку в сегодняшнюю очередь')
    assert(r.due <= DUE_CAP, `срок ${r.due.toISOString()} не должен уезжать за потолок`)
    assert(r.scheduled_days === Math.round((r.due.getTime() - now.getTime()) / DAY),
      `scheduled_days должен считаться от фактического срока, получено ${r.scheduled_days}`)
    assert(r.scheduled_days >= 0, 'отрицательный интервал не маскируется единицей и не пишется в журнал')
  }
  group('срок: зажим 24.09 при стабильности 120 больше не отправляет карточку в прошлое')

  // разброс сохранён: широкое окно у прочной карточки, узкое у хрупкой, и всё — до потолка
  const early = new Date(2026, 8, 1, 10, 0, 0)
  const days = (f: FsrsCard) => new Set(Array.from({ length: 50 }, (_, i) => clampDueBeforeCap(f, early, DUE_CAP, () => i / 50).due.getTime()))
  const wide = days(strong)
  const narrow = days(fsrs({ stability: 12, due: new Date(2027, 0, 20) }))
  assert(wide.size >= 10, `окно прочной карточки должно быть широким, получено ${wide.size} дней`)
  assert(narrow.size <= 6 && narrow.size >= 4, `окно хрупкой карточки — около недели, получено ${narrow.size} дней`)
  assert(wide.size > narrow.size, 'прочные карточки уезжают раньше хрупких — разброс по стабильности сохранён')
  assert(Math.min(...wide) < Math.min(...narrow), 'нижняя граница окна у прочной карточки должна быть раньше')
  assert(Math.max(...wide) === DUE_CAP.getTime() && Math.max(...narrow) === DUE_CAP.getTime(), 'верхняя граница окна — сам потолок')
  group('срок: разброс по стабильности сохранён, всё окно лежит между now и потолком')

  // меньше суток до потолка: разыгрывать нечего, карточка получает последний легальный слот
  const late = new Date(DUE_CAP.getTime() - 3600_000)
  const r = clampDueBeforeCap(strong, late, DUE_CAP, () => 0.99)
  assert(r.due.getTime() === DUE_CAP.getTime(), 'при остатке меньше суток срок — сам потолок')
  assert(r.due > late && r.scheduled_days === 0, 'и он всё равно в будущем, а интервал честно нулевой')
  group('срок: остаток меньше суток — последний слот перед потолком, а не розыгрыш в прошлое')

  // за что зажим не берётся вовсе
  const after = new Date(DUE_CAP.getTime() + DAY)
  assert(clampDueBeforeCap(strong, after, DUE_CAP, () => 0) === strong, 'после потолка зажимать нечего')
  const near = fsrs({ due: new Date(2026, 8, 20) })
  assert(clampDueBeforeCap(near, now, DUE_CAP, () => 0) === near, 'срок и так до потолка — не трогаем')
  const learning = fsrs({ state: State.Learning, due: new Date(2027, 0, 20) })
  assert(clampDueBeforeCap(learning, now, DUE_CAP, () => 0) === learning, 'зажим только для Review')
  group('срок: зажим не вмешивается там, где его не звали')
}

// ---- 7. Флаг «Пиявка» ----------------------------------------------------

function leechChecks(): void {
  const sick = fsrs({ reps: 9, stability: 1.4 })
  const shaky = fsrs({ reps: 9, stability: 3 })
  const healthy = fsrs({ reps: 12, stability: LEECH_STABILITY_DAYS * 3 })

  assert(isLeech(sick), 'проверка бессмысленна, если карточка не пиявка по общему предикату')
  assert(leechTransition(undefined, sick) === 'set', 'непомеченная пиявка получает флаг')
  assert(leechTransition('2026-08-01', sick) === null, 'помеченная пиявка второй раз не помечается — файл не дёргается')
  assert(leechTransition(undefined, healthy) === null, 'здоровой карточке флаг не нужен')
  group('пиявка: постановка флага по общему предикату isLeech не изменилась')

  assert(leechTransition('2026-08-01', healthy) === 'clear', 'выздоровевшая карточка теряет флаг')
  assert(leechTransition('2026-08-01', shaky) === null,
    `гистерезис: стабильность ${shaky.stability} выше порога пиявки, но ниже порога выздоровления — флаг остаётся`)
  assert(!isLeech(shaky), 'именно в этом и суть: !isLeech ещё не выздоровление')
  const relearning = fsrs({ ...healthy, state: State.Relearning })
  assert(leechTransition('2026-08-01', relearning) === null, 'карточка, только что провалившаяся в Relearning, не выздоровела')
  group('пиявка: флаг снимается с гистерезисом, а не на каждом переходе через порог')

  // цена вопроса — лишние коммиты: колебание вокруг порога не должно двигать файл
  const swings = [1.5, 2.5, 1.8, 3.9, 2.1, 5.9].map(s => leechTransition('2026-08-01', fsrs({ reps: 9, stability: s })))
  assert(swings.every(v => v === null), `колебание стабильности у порога не должно трогать файл: ${swings.join(',')}`)
  group('пиявка: колебание стабильности у порога не даёт ни одной лишней записи файла')
}

// ---- 8. Живая колода -----------------------------------------------------

function liveDeckChecks(): boolean {
  if (!existsSync(DECK_DIR)) {
    console.log(`  ⚠ живая колода не найдена (${DECK_DIR}) — проверки на реальных данных НЕ выполнены`)
    return false
  }
  const files: string[] = readdirSync(DECK_DIR).filter((f: string) => f.endsWith('.md') && !f.startsWith('_'))
  assert(files.length > 100, `в колоде ожидались сотни карточек, найдено ${files.length}`)
  const base = 'Учёба/Карточки'
  const cards = files.map(f => ({ path: `${base}/${f}`, ...parseMd(readFileSync(path.join(DECK_DIR, f), 'utf8')) }))

  // слияние карточки самой с собой не должно ничего двигать — иначе каждый pull переписывал бы файлы
  let rated = 0
  for (const c of cards) {
    const local = cardRec(c.fm, { path: c.path, body: c.body })
    const merged = mergeCard({ fm: c.fm, body: c.body }, local)
    assert(JSON.stringify(merged.fm) === JSON.stringify(c.fm), `слияние ${c.path} с самой собой изменило frontmatter`)
    if (Number(c.fm.fsrs?.reps) > 0) rated++
  }
  group(`живые данные: ${cards.length} карточек (оценённых ${rated}) — слияние с самой собой ничего не меняет`)

  // тот же откат FSRS, но на настоящей карточке с самой длинной историей
  const top = cards.filter(c => Number(c.fm.fsrs?.reps) > 0).sort((a, b) => Number(b.fm.fsrs.reps) - Number(a.fm.fsrs.reps))[0]
  assert(!!top, 'в живой колоде не нашлось ни одной оценённой карточки')
  const fresh = top.fm.fsrs
  const stale = { ...fresh, reps: Number(fresh.reps) - 2, stability: Number(fresh.stability) / 2, last_review: new Date(new Date(String(fresh.last_review)).getTime() - 2 * DAY).toISOString() }
  const won = mergeCard({ fm: top.fm, body: top.body }, cardRec({ ...top.fm, fsrs: stale }, { path: top.path }))
  assert(Number(won.fm.fsrs.reps) === Number(fresh.reps), `${top.path}: устройство со старой базой не должно откатывать reps`)
  group(`живые данные: ${top.path.split('/').pop()} (reps=${fresh.reps}) — отставшее устройство не откатывает FSRS`)

  // NFD-ловушка на настоящих путях: раньше не опознавалась ни одна карточка колоды
  const nfd = cards.map(c => c.path.normalize('NFD'))
  const seen = nfd.filter(p => isCardPath(p, base)).length
  assert(seen === cards.length, `в NFD должны опознаваться все ${cards.length} карточек, опознано ${seen}`)
  assert(deletionPlan(cards.map(c => ({ path: c.path, dirty: 0 })), nfd).length === 0,
    'колода в NFD не должна выглядеть удалённой целиком — это и есть предохранитель, снесший бы всё')
  group(`живые данные: все ${cards.length} путей опознаются в NFD, колода не уходит в удаление`)

  // журнал: сколько реальных замеров времени были за потолком
  const jdir = path.join(DECK_DIR, '_журнал')
  if (existsSync(jdir)) {
    const lines: JournalRec[] = []
    for (const f of readdirSync(jdir).filter((f: string) => f.endsWith('.ndjson') && !f.startsWith('_')) as string[]) {
      for (const raw of readFileSync(path.join(jdir, f), 'utf8').split('\n')) {
        if (!raw.trim()) continue
        try { lines.push(JSON.parse(raw)) } catch { /* сырые строки разбирает parseNdjson, здесь они не нужны */ }
      }
    }
    const timed = lines.filter(l => l.type === 'review' && typeof l.elapsed_ms === 'number')
    const over = timed.filter(l => l.elapsed_ms! > cardTimeCap(l.kind))
    for (const l of timed) {
      const capped = journalElapsedMs(l.elapsed_ms!, l.kind)
      assert(capped <= cardTimeCap(l.kind), `строка ${l.id}: замер выше потолка прошёл в журнал`)
      assert(capped === Math.min(l.elapsed_ms!, cardTimeCap(l.kind)), `строка ${l.id}: зажат не тот замер`)
    }
    const worst = Math.max(0, ...timed.map(l => l.elapsed_ms ?? 0))
    group(`живые данные: ${timed.length} строк с замером, за потолком ${over.length} (максимум ${(worst / 60_000).toFixed(1)} мин) — все зажимаются`)
  }
  return true
}

function main(): void {
  console.log('SRS слой данных — слияние/журнал/удаление/атомарность/время/срок/пиявка')
  mergeChecks()
  journalPushChecks()
  massDeleteChecks()
  atomicityChecks()
  elapsedChecks()
  dueCapChecks()
  leechChecks()
  const live = liveDeckChecks()
  console.log(`\nВсе проверки слоя данных пройдены (${passed} групп)${live ? '' : ', живая колода не подключалась'}.`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ СЛОЯ ДАННЫХ УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
