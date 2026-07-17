import { GitHubClient, GhError, type TreeEntry } from './github'
import { parseMd, serializeMd, mergeCard } from './yamlfm'
import { parseNdjson, toNdjson } from './journal'
import * as db from './db'
import type { CardRec, JournalRec, Settings } from './types'
import { monthOfDay } from './daytime'

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error' | 'ok'

export interface SyncResult {
  status: SyncStatus
  error?: string
  pulledCards?: number
  pushedFiles?: number
}

const JOURNAL_DIR = '_журнал'

const isCardPath = (p: string, base: string) =>
  p.startsWith(base + '/') && p.endsWith('.md') && !p.includes(`/${JOURNAL_DIR}/`) && !p.split('/').pop()!.startsWith('_')

const isJournalPath = (p: string, base: string) =>
  p.startsWith(`${base}/${JOURNAL_DIR}/`) && p.endsWith('.ndjson')

let running: Promise<SyncResult> | null = null

/** Полный цикл: pull (слияние) → push (если есть локальные изменения). Повторный вызов во время работы вернёт тот же promise. */
export function sync(settings: Settings): Promise<SyncResult> {
  if (running) return running
  running = doSync(settings).finally(() => { running = null })
  return running
}

async function doSync(settings: Settings): Promise<SyncResult> {
  const gh = new GitHubClient(settings.pat, settings.owner, settings.repo)
  try {
    let { headSha, treeSha, pulled } = await pull(gh, settings)

    for (let attempt = 0; attempt < 3; attempt++) {
      const cards = await db.getAllCards()
      const journal = await db.getAllJournal()
      const dirtyCards = cards.filter(c => c.dirty)
      const unsynced = journal.filter(j => !j.synced)
      if (!dirtyCards.length && !unsynced.length) {
        return { status: 'ok', pulledCards: pulled, pushedFiles: 0 }
      }

      const files: { path: string; content: string }[] = dirtyCards.map(c => ({
        path: c.path,
        content: serializeMd(c.fm, c.body)
      }))

      // журнал: помесячные ndjson — объединение всех известных строк месяца
      const months = new Set(unsynced.map(j => monthOfDay(j.day)))
      for (const mo of months) {
        const lines = journal.filter(j => monthOfDay(j.day) === mo)
        files.push({ path: `${settings.basePath}/${JOURNAL_DIR}/${mo}.ndjson`, content: toNdjson(lines) })
      }

      const blobs: { path: string; sha: string }[] = []
      for (const f of files) blobs.push({ path: f.path, sha: await gh.createBlob(f.content) })

      const newTree = await gh.createTree(treeSha, blobs)
      const nRev = unsynced.filter(j => j.type === 'review').length
      const msg = `SRS: ${nRev ? `${nRev} ревью` : 'обновление карточек'}${dirtyCards.length ? `, файлов: ${dirtyCards.length}` : ''}`
      const commitSha = await gh.createCommit(msg, newTree, headSha)

      try {
        await gh.updateRef(settings.branch, commitSha)
      } catch (e) {
        if (e instanceof GhError && (e.status === 422 || e.status === 409)) {
          // гонка с тьютором/другим устройством — перечитываем и пробуем ещё раз
          const again = await pull(gh, settings)
          headSha = again.headSha
          treeSha = again.treeSha
          continue
        }
        throw e
      }

      // успех: фиксируем чистое состояние
      const shaByPath = new Map(blobs.map(b => [b.path, b.sha]))
      await db.putCards(dirtyCards.map(c => ({ ...c, dirty: 0, sha: shaByPath.get(c.path) ?? c.sha })))
      await db.putJournal(unsynced.map(j => ({ ...j, synced: 1 })))
      await db.kvSet('lastRemoteCommit', commitSha)
      await db.kvSet('lastSyncAt', Date.now())
      return { status: 'ok', pulledCards: pulled, pushedFiles: files.length }
    }
    return { status: 'error', error: 'Не удалось записать: ветка убегает (3 попытки). Попробуйте ещё раз.' }
  } catch (e: any) {
    if (e instanceof TypeError) {
      return { status: 'offline', error: 'Нет сети — изменения сохранены локально и уедут при следующей синхронизации.' }
    }
    return { status: 'error', error: e?.message ?? String(e) }
  }
}

async function pull(gh: GitHubClient, settings: Settings): Promise<{ headSha: string; treeSha: string; pulled: number }> {
  const headSha = await gh.getHead(settings.branch)
  const { treeSha } = await gh.getCommit(headSha)
  const { entries, truncated } = await gh.getTreeRecursive(treeSha)
  if (truncated) throw new Error('Дерево репозитория обрезано GitHub API — слишком большой repo')

  const local = await db.getAllCards()
  const byPath = new Map(local.map(c => [c.path, c]))
  const remoteCards = new Map<string, TreeEntry>()
  const remoteJournals: TreeEntry[] = []
  for (const e of entries) {
    if (e.type !== 'blob') continue
    if (isCardPath(e.path, settings.basePath)) remoteCards.set(e.path, e)
    else if (isJournalPath(e.path, settings.basePath)) remoteJournals.push(e)
  }

  let pulled = 0
  const toPut: CardRec[] = []
  for (const [path, entry] of remoteCards) {
    const loc = byPath.get(path)
    if (loc && loc.sha === entry.sha) continue
    const text = await gh.getBlobText(entry.sha)
    const remote = parseMd(text)
    if (loc?.dirty) {
      // конфликт: база — удалённый файл, наш вклад — fsrs/my_sentence; остаётся dirty и уедет в push
      const merged = mergeCard(remote, loc)
      toPut.push({ path, sha: entry.sha, fm: merged.fm, body: merged.body, dirty: 1 })
    } else {
      toPut.push({ path, sha: entry.sha, fm: remote.fm, body: remote.body, dirty: 0 })
    }
    pulled++
  }
  await db.putCards(toPut)

  // удалённые в repo карточки убираем локально (кроме несинхронизированных новых)
  for (const [path, loc] of byPath) {
    if (!remoteCards.has(path) && !loc.dirty) await db.deleteCard(path)
  }

  // журнал: объединение по id
  const knownJournal = await db.getAllJournal()
  const knownIds = new Set(knownJournal.map(j => j.id))
  const journalShas = (await db.kvGet<Record<string, string>>('journalShas')) ?? {}
  const newShas: Record<string, string> = {}
  for (const e of remoteJournals) {
    newShas[e.path] = e.sha
    if (journalShas[e.path] === e.sha) continue
    const text = await gh.getBlobText(e.sha)
    const fresh = parseNdjson(text).filter(l => !knownIds.has(l.id))
    await db.putJournal(fresh.map(l => ({ ...l, synced: 1 } as JournalRec)))
  }
  await db.kvSet('journalShas', newShas)
  await db.kvSet('lastRemoteCommit', headSha)
  await db.kvSet('lastSyncAt', Date.now())
  return { headSha, treeSha, pulled }
}
