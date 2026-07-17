import { GitHubClient, GhError, type TreeEntry } from './github'
import { parseMd, serializeMd, mergeCard } from './yamlfm'
import { parseNdjson, toNdjson } from './journal'
import { buildReport } from './report'
import * as db from './db'
import type { JournalRec, Settings } from './types'
import { monthOfDay } from './daytime'

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error' | 'ok'

export interface SyncResult {
  status: SyncStatus
  error?: string
  pulledCards?: number
  pushedFiles?: number
  conflicts?: number // create/create-коллизии: локальная карточка сохранена под -N именем
  warning?: string   // не-блокирующее предупреждение (конфликт-маркеры и т.п.)
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
    let { headSha, treeSha, pulled, conflicts, warning } = await pull(gh, settings)

    for (let attempt = 0; attempt < 6; attempt++) {
      const cards = await db.getAllCards()
      const journal = await db.getAllJournal()
      const dirtyCards = cards.filter(c => c.dirty && !c.broken)
      const unsynced = journal.filter(j => !j.synced)
      if (!dirtyCards.length && !unsynced.length) {
        return { status: 'ok', pulledCards: pulled, pushedFiles: 0, conflicts, warning }
      }

      const files: { path: string; content: string }[] = dirtyCards.map(c => ({
        path: c.path,
        content: serializeMd(c.fm, c.body)
      }))

      // журнал: помесячные ndjson — объединение всех известных строк месяца + сырые невалидные строки как есть
      const rawByMonth = (await db.kvGet<Record<string, string[]>>('journalRaw')) ?? {}
      const months = new Set(unsynced.map(j => monthOfDay(j.day)))
      for (const mo of months) {
        const lines = journal.filter(j => monthOfDay(j.day) === mo)
        files.push({ path: `${settings.basePath}/${JOURNAL_DIR}/${mo}.ndjson`, content: toNdjson(lines, rawByMonth[`${settings.basePath}/${JOURNAL_DIR}/${mo}.ndjson`] ?? []) })
      }

      // отчёт для тьютора — перегенерируется при каждом push-е
      const pause = settings.pauseFrom && settings.pauseTo ? { from: settings.pauseFrom, to: settings.pauseTo } : null
      files.push({ path: `${settings.basePath}/_отчёт.md`, content: buildReport(cards, journal, new Date(), pause) })

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
          // гонка с тьютором/другим устройством — бэкофф с джиттером и ещё попытка
          await new Promise(r => setTimeout(r, 500 * 2 ** attempt + Math.random() * 400))
          const again = await pull(gh, settings)
          headSha = again.headSha
          treeSha = again.treeSha
          conflicts += again.conflicts
          warning = warning ?? again.warning
          continue
        }
        throw e
      }

      // успех: dirty снимается только с неизменившихся записей (оценка во время push-а не теряется)
      const shaByPath = new Map(blobs.map(b => [b.path, b.sha]))
      const contentByPath = new Map(files.map(f => [f.path, f.content]))
      await db.confirmPushed(
        dirtyCards.map(c => ({ path: c.path, sha: shaByPath.get(c.path)!, content: contentByPath.get(c.path)! })),
        rec => serializeMd(rec.fm, rec.body)
      )
      await db.putJournal(unsynced.map(j => ({ ...j, synced: 1 })))
      // shas только что записанных журнальных файлов — чтобы следующий pull их не перекачивал
      const jShas = (await db.kvGet<Record<string, string>>('journalShas')) ?? {}
      for (const f of files) {
        if (isJournalPath(f.path, settings.basePath)) jShas[f.path] = shaByPath.get(f.path)!
      }
      await db.kvSet('journalShas', jShas)
      await db.kvSet('lastRemoteCommit', commitSha)
      await db.kvSet('lastSyncAt', Date.now())
      return { status: 'ok', pulledCards: pulled, pushedFiles: files.length, conflicts, warning }
    }
    return { status: 'error', error: 'Не удалось записать: ветка убегает (6 попыток). Оценки сохранены локально — попробуйте позже.' }
  } catch (e: any) {
    if (e instanceof GhError && e.status === 0) {
      return { status: 'offline', error: 'Нет сети — изменения сохранены локально и уедут при следующей синхронизации.' }
    }
    if (e instanceof GhError && e.status === 401) {
      return { status: 'error', error: 'Токен GitHub недействителен или истёк — создайте новый и обновите в Настройках. Оценки сохранены локально.' }
    }
    if (e instanceof db.MassDeleteError) {
      await db.kvSet('pendingMassDelete', Date.now())
      return { status: 'error', error: `Синхронизация хочет удалить ${e.count} из ${e.total} карточек. Если это ожидаемо (чистка колоды) — нажмите Синк ещё раз в течение 10 минут.` }
    }
    return { status: 'error', error: e?.message ?? String(e) }
  }
}

async function pull(gh: GitHubClient, settings: Settings): Promise<{ headSha: string; treeSha: string; pulled: number; conflicts: number; warning?: string }> {
  const headSha = await gh.getHead(settings.branch)
  const { treeSha } = await gh.getCommit(headSha)
  const { entries, truncated } = await gh.getTreeRecursive(treeSha)
  if (truncated) throw new Error('Дерево репозитория обрезано GitHub API — слишком большой repo')

  const local = await db.getAllCards()
  const shaByPath = new Map(local.map(c => [c.path, c.sha]))
  const remoteCards = new Map<string, TreeEntry>()
  const remoteJournals: TreeEntry[] = []
  for (const e of entries) {
    if (e.type !== 'blob') continue
    if (isCardPath(e.path, settings.basePath)) remoteCards.set(e.path, e)
    else if (isJournalPath(e.path, settings.basePath)) remoteJournals.push(e)
  }

  // сетевые запросы — ДО транзакции; снапшот используется только для sha-skip
  const fetched: db.FetchedCard[] = []
  const conflictedFiles: string[] = []
  for (const [path, entry] of remoteCards) {
    if (shaByPath.get(path) === entry.sha) continue
    const text = await gh.getBlobText(entry.sha)
    const remote = parseMd(text)
    // git-конфликт-маркеры (watcher слил криво) — карантин, даже если YAML случайно распарсился
    const conflicted = text.includes('<<<<<<<') || text.includes('>>>>>>>')
    if (conflicted) conflictedFiles.push(path.split('/').pop()!)
    fetched.push({ path, sha: entry.sha, fm: remote.fm, body: remote.body, broken: conflicted ? 1 : remote.broken })
  }
  // подтверждение массового удаления: второй Синк в течение 10 минут после предупреждения
  const pendingTs = await db.kvGet<number>('pendingMassDelete')
  const allowMass = !!pendingTs && Date.now() - pendingTs < 10 * 60_000
  const conflicts = await db.applyPull(fetched, new Set(remoteCards.keys()), mergeCard, allowMass)
  if (allowMass) await db.kvSet('pendingMassDelete', 0)
  const warning = conflictedFiles.length
    ? `⚠️ Git-конфликт в: ${conflictedFiles.join(', ')} — карточки в карантине, почините <<<<<<< в vault`
    : undefined

  // журнал: объединение по id; невалидные строки сохраняются сырыми и не теряются при перезаписи
  const knownJournal = await db.getAllJournal()
  const knownIds = new Set(knownJournal.map(j => j.id))
  const journalShas = (await db.kvGet<Record<string, string>>('journalShas')) ?? {}
  const rawByMonth = (await db.kvGet<Record<string, string[]>>('journalRaw')) ?? {}
  const newShas: Record<string, string> = {}
  for (const e of remoteJournals) {
    newShas[e.path] = e.sha
    if (journalShas[e.path] === e.sha) continue
    const text = await gh.getBlobText(e.sha)
    const parsed = parseNdjson(text)
    const fresh = parsed.lines.filter(l => !knownIds.has(l.id))
    await db.putJournal(fresh.map(l => ({ ...l, synced: 1 } as JournalRec)))
    if (parsed.rejects.length) {
      const prev = new Set(rawByMonth[e.path] ?? [])
      parsed.rejects.forEach(r => prev.add(r))
      rawByMonth[e.path] = [...prev]
    }
  }
  await db.kvSet('journalRaw', rawByMonth)
  await db.kvSet('journalShas', newShas)
  await db.kvSet('lastRemoteCommit', headSha)
  await db.kvSet('lastSyncAt', Date.now())
  return { headSha, treeSha, pulled: fetched.length, conflicts, warning }
}
