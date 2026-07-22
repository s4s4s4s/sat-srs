import { openDB, type IDBPDatabase } from 'idb'
import type { CardRec, JournalRec } from './types'

let dbp: Promise<IDBPDatabase> | null = null

function db() {
  if (!dbp) {
    dbp = openDB('sat-srs', 1, {
      upgrade(d) {
        d.createObjectStore('cards', { keyPath: 'path' })
        const j = d.createObjectStore('journal', { keyPath: 'id' })
        j.createIndex('by_day', 'day')
        d.createObjectStore('kv')
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
 * Полная очистка локального кэша: карточки, журнал и служебные ключи синка
 * (shas, сырые строки журнала, метки последнего коммита) — одной транзакцией.
 * Настройки подключения и PAT живут в localStorage и НЕ затрагиваются:
 * в этом смысл функции — сбросить состояние без повторного ввода токена.
 */
export async function clearLocalData(): Promise<void> {
  const tx = (await db()).transaction(['cards', 'journal', 'kv'], 'readwrite')
  await Promise.all([
    tx.objectStore('cards').clear(),
    tx.objectStore('journal').clear(),
    tx.objectStore('kv').clear()
  ])
  await tx.done
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
  constructor(public count: number, public total: number) {
    super(`mass delete: ${count}/${total}`)
  }
}

export async function applyPull(
  fetched: FetchedCard[],
  remotePaths: Set<string>,
  merge: (remote: { fm: Record<string, any>; body: string }, local: CardRec) => { fm: Record<string, any>; body: string },
  allowMassDelete = false
): Promise<number> {
  const tx = (await db()).transaction('cards', 'readwrite')
  const totalBefore = await tx.store.count()
  let conflicts = 0
  for (const f of fetched) {
    const cur = (await tx.store.get(f.path)) as CardRec | undefined
    if (cur?.dirty && cur.sha === null && !cur.broken) {
      // оба «создали» этот путь: remote остаётся как есть, локальная уезжает на свободный -N путь
      let n = 2
      let alt = f.path.replace(/\.md$/, `-${n}.md`)
      while (remotePaths.has(alt) || (await tx.store.get(alt))) alt = f.path.replace(/\.md$/, `-${++n}.md`)
      await tx.store.put({ ...cur, path: alt })
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
      const lostFirstSeen = ok && cur.fm.first_seen && !f.fm.first_seen
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
  // удалённые в repo файлы: удаляем локально; исключение — только ещё не пушенные новые (sha=null).
  // Карточка с sha≠null существовала в repo → её отсутствие это осознанное удаление, оно побеждает даже dirty.
  // Предохранитель: массовое удаление (кривой basePath, битая ветка, слетевший тьютор) требует подтверждения —
  // throw откатывает ВСЮ транзакцию, включая уже применённые puts.
  const toDelete: IDBValidKey[] = []
  let cursor = await tx.store.openCursor()
  while (cursor) {
    const c = cursor.value as CardRec
    if (!remotePaths.has(c.path) && !(c.dirty && c.sha === null)) toDelete.push(cursor.key)
    cursor = await cursor.continue()
  }
  if (!allowMassDelete && toDelete.length > 10 && toDelete.length > totalBefore * 0.2) {
    try { tx.abort() } catch { /* уже завершена */ }
    throw new MassDeleteError(toDelete.length, totalBefore)
  }
  for (const k of toDelete) await tx.store.delete(k)
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

export async function getAllJournal(): Promise<JournalRec[]> {
  return (await db()).getAll('journal')
}

export async function putJournal(lines: JournalRec[]): Promise<void> {
  if (!lines.length) return
  const tx = (await db()).transaction('journal', 'readwrite')
  await Promise.all(lines.map(l => tx.store.put(l)))
  await tx.done
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await db()).get('kv', key)
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key)
}
