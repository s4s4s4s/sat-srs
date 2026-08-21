import { openDB, type IDBPDatabase } from 'idb'
import type { CardRec, JournalRec, ReadingRec } from './types'

let dbp: Promise<IDBPDatabase> | null = null

/**
 * Версия схемы локальной базы. Поднимается на каждое изменение состава хранилищ.
 *
 * Миграция идёт шагами `oldVersion < N`, а не переписыванием тела upgrade: у установленного
 * PWA база УЖЕ создана первой версией, и повторный createObjectStore('cards') на ней упал бы
 * с ConstraintError, оставив приложение без базы вовсе. Шаги выполняются подряд, поэтому
 * устройство любой давности догоняет текущую схему за один open.
 *
 * v2 (21.08.2026) — хранилище `readings`: тексты для чтения.
 */
const DB_VERSION = 2

function db() {
  if (!dbp) {
    dbp = openDB('sat-srs', DB_VERSION, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore('cards', { keyPath: 'path' })
          const j = d.createObjectStore('journal', { keyPath: 'id' })
          j.createIndex('by_day', 'day')
          d.createObjectStore('kv')
        }
        if (oldVersion < 2) {
          d.createObjectStore('readings', { keyPath: 'path' })
        }
      }
    })
    // WebKit иногда фейлит первый open — сбрасываем мемоизацию, чтобы retry был возможен
    dbp.catch(() => { dbp = null })
  }
  return dbp
}

export async function getAllCards(): Promise<CardRec[]> {
  return (await db()).getAll('cards')
}

export async function putCard(c: CardRec): Promise<void> {
  await (await db()).put('cards', c)
}

export async function putCards(cs: CardRec[]): Promise<void> {
  const tx = (await db()).transaction('cards', 'readwrite')
  await Promise.all(cs.map(c => tx.store.put(c)))
  await tx.done
}

export async function deleteCard(path: string): Promise<void> {
  await (await db()).delete('cards', path)
}

/**
 * Канонический вид пути для СРАВНЕНИЯ (не для записи).
 *
 * Кириллица в имени файла имеет две равноправные формы записи в Unicode: NFC («й» одним
 * кодом) и NFD («и» + комбинирующая бреве). Git хранит байты, а macOS отдаёт имена в NFD —
 * значит один и тот же файл может прийти из репозитория в форме, отличной от локальной,
 * и посимвольное сравнение путей его не узнает. Цена промаха здесь максимальная: путь,
 * не опознанный как карточка, отсутствует в remotePaths, а отсутствие в remotePaths — это
 * команда на удаление. Одна колода в NFD снесла бы всю локальную базу целиком.
 *
 * Записываем при этом ровно тот путь, что пришёл из репозитория: NFC-нормализация имени
 * при push-е создала бы в git ВТОРОЙ файл рядом с существующим — байты-то другие.
 */
export const nfcPath = (p: string) => p.normalize('NFC')

/**
 * Полная очистка локального кэша: карточки, журнал и служебные ключи синка
 * (shas, сырые строки журнала, метки последнего коммита) — одной транзакцией.
 * Настройки подключения и PAT живут в localStorage и НЕ затрагиваются:
 * в этом смысл функции — сбросить состояние без повторного ввода токена.
 */
export async function clearLocalData(): Promise<void> {
  const tx = (await db()).transaction(['cards', 'journal', 'kv', 'readings'], 'readwrite')
  await Promise.all([
    tx.objectStore('cards').clear(),
    tx.objectStore('journal').clear(),
    tx.objectStore('kv').clear(),
    tx.objectStore('readings').clear()
  ])
  await tx.done
}

/** Слово, у которого была хотя бы одна оценка: fsrs-блок есть и reps > 0 (знакомство reps не даёт). */
export function hasRatedFsrs(fm: Record<string, any>): boolean {
  const f = fm.fsrs
  return !!f && typeof f === 'object' && Number(f.reps) > 0
}

export interface FetchedCard {
  path: string
  sha: string
  fm: Record<string, any>
  body: string
  broken?: number
}

/**
 * Применение pull-а ОДНОЙ readwrite-транзакцией: решения dirty/merge/delete принимаются
 * по СВЕЖИМ записям, а не по снапшоту до сетевых запросов — оценка, сделанная во время
 * долгого pull-а, не может быть затёрта или удалена.
 * Возвращает число create/create-конфликтов (локальная карточка переехала на -N путь).
 */
export class MassDeleteError extends Error {
  constructor(public count: number, public total: number, public paths: string[]) {
    super(`mass delete: ${count}/${total}`)
  }
}

/** Подтверждение массового удаления: когда выдано и ЧТО именно собирались удалить. */
export interface MassDeletePending {
  ts: number
  paths: string[]
}

/** Порог предохранителя: больше 10 карточек И больше пятой части колоды — это уже не правка, а обвал. */
export const MASS_DELETE_MIN = 10
export const MASS_DELETE_SHARE = 0.2
/** Сколько живёт подтверждение. Дольше — и «да, чистка» относилось бы уже к другому событию. */
export const MASS_DELETE_CONFIRM_MS = 10 * 60_000

export function massDeleteNeedsConfirm(count: number, total: number): boolean {
  return count > MASS_DELETE_MIN && count > total * MASS_DELETE_SHARE
}

/**
 * Что удалить локально: карточка исчезла из репозитория И не имеет неотправленных изменений.
 *
 * Прежнее условие берегло только ни разу не отправленные карточки (`dirty && sha === null`),
 * а карточку с sha и неотправленной оценкой удаляло вместе с этой оценкой — работа ученика
 * пропадала молча. Теперь dirty защищает всегда, независимо от sha.
 *
 * Цена решения названа честно: карточку, которую тьютор удалил из репозитория, а ученик успел
 * оценить до синхронизации, ближайший push вернёт в репозиторий обратно. Тьютору придётся
 * удалить её ещё раз — уже после того, как оценка доехала. Обратный размен (молча потерять
 * оценку, чтобы избавить тьютора от второго удаления) дороже: удаление легко повторить,
 * потерянный повтор не восстановить ничем.
 */
export function deletionPlan(local: { path: string; dirty?: number }[], remotePaths: Iterable<string>): string[] {
  const remote = new Set([...remotePaths].map(nfcPath))
  return local.filter(c => !remote.has(nfcPath(c.path)) && !c.dirty).map(c => c.path)
}

/**
 * Действительно ли лежащее подтверждение разрешает именно ЭТО удаление.
 *
 * Раньше подтверждением был голый таймстемп: любое второе нажатие «Синк» в течение десяти
 * минут разрешало удалить что угодно, включая состав, изменившийся с момента предупреждения.
 * А нажать ещё раз — ровно то, что человек делает в ответ на ошибку. Теперь подтверждение
 * привязано к списку путей: изменился состав — подтверждение недействительно, предупреждение
 * выдаётся заново уже с новым списком. Подтверждение старого формата (число) не принимается:
 * списка в нём нет, значит и сверять нечего.
 */
export function massDeleteConfirmed(pending: unknown, planned: string[], now: number): boolean {
  if (!pending || typeof pending !== 'object') return false
  const p = pending as Partial<MassDeletePending>
  if (!Number.isFinite(p.ts) || !Array.isArray(p.paths)) return false
  // now < ts — часы устройства ушли назад; такое подтверждение не датируется и не годится
  if (now < p.ts! || now - p.ts! > MASS_DELETE_CONFIRM_MS) return false
  const confirmed = new Set(p.paths.map(nfcPath))
  const want = planned.map(nfcPath)
  return confirmed.size === want.length && want.every(x => confirmed.has(x))
}

export async function applyPull(
  fetched: FetchedCard[],
  remotePaths: Set<string>,
  merge: (remote: { fm: Record<string, any>; body: string }, local: CardRec) => { fm: Record<string, any>; body: string },
  pendingMassDelete: unknown = null
): Promise<number> {
  const tx = (await db()).transaction('cards', 'readwrite')
  const totalBefore = await tx.store.count()
  // индекс локальных записей по канонической форме пути: ключ в базе мог быть записан
  // в другой нормализации Unicode, чем пришедший из репозитория путь (см. nfcPath)
  const localByNorm = new Map<string, CardRec>()
  for (let c = await tx.store.openCursor(); c; c = await c.continue()) {
    const rec = c.value as CardRec
    localByNorm.set(nfcPath(rec.path), rec)
  }
  const remoteNorm = new Set([...remotePaths].map(nfcPath))
  let conflicts = 0
  for (const f of fetched) {
    const cur = localByNorm.get(nfcPath(f.path))
    // репозиторий — источник истины для самого написания пути: если локальный ключ записан
    // в другой нормализации, старая запись убирается, иначе рядом остались бы две карточки
    // на один файл (и «лишняя» из них при первой же чистке ушла бы в удаление)
    if (cur && cur.path !== f.path) await tx.store.delete(cur.path)
    if (cur?.dirty && cur.sha === null && !cur.broken) {
      // оба «создали» этот путь: remote остаётся как есть, локальная уезжает на свободный -N путь
      let n = 2
      let alt = f.path.replace(/\.md$/, `-${n}.md`)
      while (remoteNorm.has(nfcPath(alt)) || localByNorm.has(nfcPath(alt))) alt = f.path.replace(/\.md$/, `-${++n}.md`)
      const moved = { ...cur, path: alt }
      await tx.store.put(moved)
      localByNorm.delete(nfcPath(cur.path))
      localByNorm.set(nfcPath(alt), moved) // занятое имя видно следующей итерации: -2 не выдаётся дважды
      await tx.store.put({ path: f.path, sha: f.sha, fm: f.fm, body: f.body, dirty: 0, broken: f.broken })
      conflicts++
    } else if (cur?.dirty && !cur.broken) {
      // remote — база (тьютор мог править текст), наш вклад — только fsrs/my_sentence; остаётся dirty
      const m = merge({ fm: f.fm, body: f.body }, cur)
      await tx.store.put({ path: f.path, sha: f.sha, fm: m.fm, body: m.body, dirty: 1, broken: f.broken })
    } else {
      // чистая запись: fsrs-блоки/my_sentence принадлежат приложению — если тьютор переписал
      // файл и потерял их, восстанавливаем из локальной копии и пушим обратно (dirty=1).
      // fsrs_prep восстанавливаем только пока prep-поля живы: их удаление — осознанное.
      const ok = cur && !cur.broken && !f.broken
      const lostFsrs = ok && cur.fm.fsrs && typeof cur.fm.fsrs === 'object' && (!f.fm.fsrs || typeof f.fm.fsrs !== 'object')
      const lostPrep = ok && cur.fm.fsrs_prep && f.fm.prep && f.fm.prep_context && !f.fm.fsrs_prep
      const lostSentence = ok && cur.fm.my_sentence && !f.fm.my_sentence
      // A7: first_seen восстанавливаем только у слова, которое реально оценивали (есть fsrs с reps>0).
      // Иначе снятая тьютором дата «сожжённого» знакомства (показали и бросили без отработки)
      // возвращалась бы приложением обратно, и слово навсегда оставалось бы вне ввода.
      const lostFirstSeen = ok && cur.fm.first_seen && !f.fm.first_seen && hasRatedFsrs(cur.fm)
      if (lostFsrs || lostPrep || lostSentence || lostFirstSeen) {
        const fm = { ...f.fm }
        if (lostFsrs) fm.fsrs = cur!.fm.fsrs
        if (lostPrep) fm.fsrs_prep = cur!.fm.fsrs_prep
        if (lostSentence) fm.my_sentence = cur!.fm.my_sentence
        if (lostFirstSeen) fm.first_seen = cur!.fm.first_seen
        await tx.store.put({ path: f.path, sha: f.sha, fm, body: f.body, dirty: 1, broken: f.broken })
      } else {
        await tx.store.put({ path: f.path, sha: f.sha, fm: f.fm, body: f.body, dirty: 0, broken: f.broken })
      }
    }
  }
  // удалённые в repo файлы: удаляем локально, но никогда — карточку с неотправленными
  // изменениями (deletionPlan, там же цена этого решения). Состав считаем по СВЕЖИМ записям:
  // dirty мог появиться уже после начала транзакции.
  // Предохранитель: массовое удаление (кривой basePath, битая ветка, слетевший тьютор) требует
  // подтверждения ИМЕННО ЭТОГО состава — throw откатывает ВСЮ транзакцию, включая уже применённые puts.
  const live: CardRec[] = []
  for (let c = await tx.store.openCursor(); c; c = await c.continue()) live.push(c.value as CardRec)
  const toDelete = deletionPlan(live, remoteNorm)
  if (massDeleteNeedsConfirm(toDelete.length, totalBefore) && !massDeleteConfirmed(pendingMassDelete, toDelete, Date.now())) {
    try { tx.abort() } catch { /* уже завершена */ }
    throw new MassDeleteError(toDelete.length, totalBefore, toDelete)
  }
  for (const p of toDelete) await tx.store.delete(p)
  await tx.done
  return conflicts
}

/**
 * Фиксация успешного push-а: dirty снимается ТОЛЬКО если текущее содержимое записи
 * всё ещё равно запушенному (оценка во время push-а оставляет карточку dirty
 * и уедет следующим циклом). sha обновляется всегда — это новая база в repo.
 */
export async function confirmPushed(
  pushed: { path: string; sha: string; content: string }[],
  serialize: (rec: CardRec) => string
): Promise<void> {
  const tx = (await db()).transaction('cards', 'readwrite')
  for (const p of pushed) {
    const cur = (await tx.store.get(p.path)) as CardRec | undefined
    if (!cur) continue
    const unchanged = serialize(cur) === p.content
    await tx.store.put({ ...cur, sha: p.sha, dirty: unchanged ? 0 : 1 })
  }
  await tx.done
}

/* ---- тексты для чтения ---------------------------------------------------- */

export async function getAllReadings(): Promise<ReadingRec[]> {
  return (await db()).getAll('readings')
}

/**
 * Что удалить из локального кэша текстов: текст исчез из репозитория.
 *
 * В отличие от карточек, здесь нет ни `dirty`, ни предохранителя массового удаления, и это
 * не упрощение. Текст — материал, который приложение только читает: удалять вместе с ним
 * нечего, а вернуть его обратно умеет ближайшая синхронизация. Вся история чтения — отметки
 * незнакомых слов и строки прочтения — живёт в журнале, в другом хранилище, которое эта
 * транзакция вообще не открывает; строка отметки самодостаточна (слово, лемма, предложение
 * внутри неё), поэтому переживает исчезновение текста и остаётся читаемой тьютору.
 */
export function readingsDeletionPlan(local: { path: string }[], remotePaths: Iterable<string>): string[] {
  const remote = new Set([...remotePaths].map(nfcPath))
  return local.filter(r => !remote.has(nfcPath(r.path))).map(r => r.path)
}

/**
 * Применение pull-а текстов одной транзакцией. Возвращает число удалённых.
 * Нормализация Unicode в путях — та же и по той же причине, что у карточек (nfcPath).
 */
export async function applyReadingsPull(fetched: ReadingRec[], remotePaths: Set<string>): Promise<number> {
  const tx = (await db()).transaction('readings', 'readwrite')
  const localByNorm = new Map<string, ReadingRec>()
  for (let c = await tx.store.openCursor(); c; c = await c.continue()) {
    const rec = c.value as ReadingRec
    localByNorm.set(nfcPath(rec.path), rec)
  }
  for (const f of fetched) {
    const cur = localByNorm.get(nfcPath(f.path))
    // репозиторий — источник истины для написания пути (см. nfcPath у карточек)
    if (cur && cur.path !== f.path) await tx.store.delete(cur.path)
    await tx.store.put(f)
    localByNorm.set(nfcPath(f.path), f)
  }
  const live: ReadingRec[] = []
  for (let c = await tx.store.openCursor(); c; c = await c.continue()) live.push(c.value as ReadingRec)
  const toDelete = readingsDeletionPlan(live, [...remotePaths].map(nfcPath))
  for (const p of toDelete) await tx.store.delete(p)
  await tx.done
  return toDelete.length
}

export async function getAllJournal(): Promise<JournalRec[]> {
  return (await db()).getAll('journal')
}

export async function putJournal(lines: JournalRec[]): Promise<void> {
  if (!lines.length) return
  const tx = (await db()).transaction('journal', 'readwrite')
  await Promise.all(lines.map(l => tx.store.put(l)))
  await tx.done
}

/**
 * Оценка карточки — ОДНА операция, а не две.
 *
 * Расписание карточки живёт в хранилище `cards`, а факт показа — строкой в `journal`, и писались
 * они двумя отдельными транзакциями. Сбой между ними (закрытая вкладка, выселенная iOS страница,
 * упавшая запись) двигал срок повтора без строки в журнале — то есть показ переставал существовать
 * для всей отчётности: дневная норма новых, обязательная отработка слова в день знакомства, серия
 * дней и ретеншн считаются по журналу. Карточка при этом уезжала на неделю вперёд.
 *
 * Одна транзакция на два хранилища снимает вопрос: либо есть и новое расписание, и строка,
 * либо не изменилось ничего.
 */
export async function putCardAndJournal(card: CardRec, lines: JournalRec[]): Promise<void> {
  const tx = (await db()).transaction(['cards', 'journal'], 'readwrite')
  const journal = tx.objectStore('journal')
  await Promise.all([
    tx.objectStore('cards').put(card),
    ...lines.map(l => journal.put(l))
  ])
  await tx.done
}

/** Поля строки журнала без служебного `synced`, отсортированные по имени — канонический вид
 *  для сравнения «изменилась ли строка». Сортировка нужна, потому что дописанное поле
 *  (`cause`) меняет порядок ключей, а порядок не должен решать за содержимое. */
function journalCanon(l: JournalRec): string {
  const keys = Object.keys(l).filter(k => k !== 'synced').sort()
  return JSON.stringify(keys.map(k => [k, (l as Record<string, any>)[k]]))
}

/** Осталась ли строка журнала той же, что уехала в repo. */
export function journalUnchanged(cur: JournalRec | undefined, pushed: JournalRec): boolean {
  return !!cur && journalCanon(cur) === journalCanon(pushed)
}

/**
 * Фиксация успешного push-а журнала — зеркало confirmPushed для карточек.
 *
 * `synced` снимался по снимку, взятому ДО сетевых запросов: если ученик за это время выбирал
 * причину ошибки (setCause дописывает `cause` в ту же строку), поле затиралось снимком, строка
 * помечалась отправленной и не уезжала уже никогда — самоотчёт пропадал молча. Асимметрия
 * с карточками, где та же ловушка была закрыта, и была дефектом; здесь то же правило:
 * отправленной помечается только строка, не изменившаяся с момента снимка.
 */
export async function confirmJournalPushed(pushed: JournalRec[]): Promise<void> {
  if (!pushed.length) return
  const tx = (await db()).transaction('journal', 'readwrite')
  for (const p of pushed) {
    const cur = (await tx.store.get(p.id)) as JournalRec | undefined
    if (!cur) continue
    if (journalUnchanged(cur, p)) await tx.store.put({ ...cur, synced: 1 })
  }
  await tx.done
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await db()).get('kv', key)
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key)
}
