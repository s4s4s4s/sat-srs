import { GitHubClient, GhError, type TreeEntry } from './github'
import { parseMd, serializeMd, mergeCard, cardView } from './yamlfm'
import { parseNdjson, toNdjson } from './journal'
import { buildReport } from './report'
import { buildMetricsSnapshot, appendDailySnapshot } from './metrics'
import { EXAM_DATE } from './scheduler'
import * as db from './db'
import type { JournalRec, ReadingRec, Settings } from './types'
import { monthOfDay, dayKey } from './daytime'

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error' | 'ok'

export interface SyncResult {
  status: SyncStatus
  error?: string
  pulledCards?: number
  pushedFiles?: number
  conflicts?: number // create/create-коллизии: локальная карточка сохранена под -N именем
  pulledTexts?: number // тексты для чтения, обновлённые в этом цикле
  warning?: string   // не-блокирующее предупреждение (конфликт-маркеры и т.п.)
}

const JOURNAL_DIR = '_журнал'
const READING_DIR = 'Чтение'

/* Пути сравниваются в канонической форме Unicode (db.nfcPath), а не как есть.
   Всё, что решают предикаты ниже, держится на кириллице в путях: и базовый каталог колоды,
   и имя каталога журнала. Файл, созданный на macOS, приходит из репозитория в NFD — те же
   буквы, другие байты, — и тогда `startsWith(base)` не срабатывает НИ НА ОДНОЙ карточке:
   remoteCards пуст, приложение считает, что колоды в репозитории больше нет, и предохранитель
   массового удаления встречает пустой список удалённого. То же с `_журнал`: не опознанный
   каталог журнала утащил бы ndjson-файлы в разбор карточек. */
export const isCardPath = (p: string, base: string) => {
  const path = db.nfcPath(p)
  return path.startsWith(db.nfcPath(base) + '/') && path.endsWith('.md')
    && !path.includes(`/${JOURNAL_DIR}/`) && !path.split('/').pop()!.startsWith('_')
}

// месячные журналы (2026-07.ndjson) — но НЕ служебные `_`-файлы (_метрики.ndjson): у последних
// нет id/ts/day, они сломали бы parseNdjson и уехали бы в rawByMonth. Метрики тянутся адресно.
export const isJournalPath = (p: string, base: string) => {
  const path = db.nfcPath(p)
  return path.startsWith(`${db.nfcPath(base)}/${JOURNAL_DIR}/`) && path.endsWith('.ndjson')
    && !path.split('/').pop()!.startsWith('_')
}

/**
 * Каталог текстов для чтения — сосед каталога колоды: `Учёба/Карточки` → `Учёба/Чтение`
 * (`_КОНТРАКТ.md`, раздел «Чтение»: тексты живут рядом с колодой, но не в ней).
 *
 * Выводится из basePath, а не хранится отдельной настройкой, намеренно: второй путь в
 * настройках — это второй способ ошибиться при том же самом репозитории, и чинить его
 * пришлось бы вслепую (ученик не знает, что такое каталог текстов). Репозиторий, ветка и
 * токен остаются единственным, что настраивается руками.
 */
export function readingBase(base: string): string {
  const clean = base.replace(/\/+$/, '')
  const cut = clean.lastIndexOf('/')
  return (cut >= 0 ? clean.slice(0, cut + 1) : '') + READING_DIR
}

export const isReadingPath = (p: string, base: string) => {
  const path = db.nfcPath(p)
  return path.startsWith(db.nfcPath(readingBase(base)) + '/') && path.endsWith('.md')
    && !path.split('/').pop()!.startsWith('_')
}

/**
 * Текст предупреждения о массовом удалении.
 *
 * Прежний звал «нажмите Синк ещё раз в течение 10 минут» и не называл ни одного файла: реакция
 * на ошибку — нажать ещё раз — и выполняла удаление вслепую. Теперь человек видит, СКОЛЬКО и ЧТО
 * именно уйдёт, и подтверждает уже конкретный список (db.massDeleteConfirmed): изменился состав —
 * подтверждение не действует.
 */
export function massDeleteMessage(e: db.MassDeleteError): string {
  const SHOW = 10
  const names = e.paths.slice(0, SHOW).map(p => p.split('/').pop())
  const tail = e.paths.length > SHOW ? ` и ещё ${e.paths.length - SHOW}` : ''
  return `Синхронизация хочет удалить ${e.count} карточек из ${e.total}: ${names.join(', ')}${tail}. `
    + 'Локально пока не удалено ничего. Если это не чистка колоды — проверьте репозиторий, ветку и путь в Настройках. '
    + `Если чистка — повторный Синк в течение ${Math.round(db.MASS_DELETE_CONFIRM_MS / 60_000)} минут удалит ровно эти файлы; `
    + 'при любом другом составе подтверждение не сработает.'
}

const metricsPathOf = (base: string) => `${base}/${JOURNAL_DIR}/_метрики.ndjson`

/** Слитый криво файл: писать такой нельзя, показывать — незачем (см. места вызова). */
const hasConflictMarkers = (text: string) => text.includes('<<<<<<<') || text.includes('>>>>>>>')

/** Сколько блобов качаем параллельно: 150+ файлов по одному — это 150+ round-trip. */
const CONCURRENCY = 8

/** Пул скачиваний: порядок обхода неважен, важно не вставать в очередь по одному запросу. */
async function pooled<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await work(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
}

let running: Promise<SyncResult> | null = null

/** Дождаться завершения идущего цикла (или вернуться сразу, если его нет).
 *  Нужно перед сбросом кэша: очистка посреди push-а вернула бы старые данные обратно. */
export async function syncIdle(): Promise<void> {
  try { await running } catch { /* исход неважен — ждём только завершения */ }
}

/** Полный цикл: pull (слияние) → push (если есть локальные изменения). Повторный вызов во время работы вернёт тот же promise. */
export function sync(settings: Settings): Promise<SyncResult> {
  if (running) return running
  running = doSync(settings).finally(() => { running = null })
  return running
}

async function doSync(settings: Settings): Promise<SyncResult> {
  const gh = new GitHubClient(settings.pat, settings.owner, settings.repo)
  try {
    let { headSha, treeSha, pulled, texts, conflicts, warning } = await pull(gh, settings)

    for (let attempt = 0; attempt < 6; attempt++) {
      const cards = await db.getAllCards()
      const journal = await db.getAllJournal()
      const dirtyCards = cards.filter(c => c.dirty && !c.broken)
      const unsynced = journal.filter(j => !j.synced)
      if (!dirtyCards.length && !unsynced.length) {
        return { status: 'ok', pulledCards: pulled, pulledTexts: texts, pushedFiles: 0, conflicts, warning }
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

      // история метрик: одна строка в день (граница учебного дня 04:00). Снимок агрегатов слоёв 1–3;
      // exam-ready и медианная стабильность задним числом не восстановить — состояние карт перезаписывается.
      const metricsPath = metricsPathOf(settings.basePath)
      const metricsExisting = (await db.kvGet<string>('metricsText')) ?? ''
      const snapshot = buildMetricsSnapshot(cards.filter(c => !c.broken).map(cardView), journal, new Date(), EXAM_DATE)
      const metrics = appendDailySnapshot(metricsExisting, snapshot)
      if (metrics.appended) files.push({ path: metricsPath, content: metrics.text })

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
          texts += again.texts
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
      // то же правило для журнала: `synced` ставится по СВЕЖЕЙ записи, а не по снимку `unsynced`,
      // взятому до сетевых запросов. Причина ошибки, выбранная учеником во время push-а, дописывается
      // в ту же строку — по снимку она затиралась бы и уезжала бы в «уже отправлено» навсегда.
      await db.confirmJournalPushed(unsynced)
      // shas только что записанных журнальных файлов — чтобы следующий pull их не перекачивал
      const jShas = (await db.kvGet<Record<string, string>>('journalShas')) ?? {}
      for (const f of files) {
        if (isJournalPath(f.path, settings.basePath)) jShas[f.path] = shaByPath.get(f.path)!
      }
      await db.kvSet('journalShas', jShas)
      // метрики: кэшируем свежий текст и sha, чтобы следующий pull не тянул только что записанное
      if (metrics.appended) {
        await db.kvSet('metricsText', metrics.text)
        const mSha = shaByPath.get(metricsPath)
        if (mSha) await db.kvSet('metricsSha', mSha)
      }
      await db.kvSet('lastRemoteCommit', commitSha)
      await db.kvSet('lastSyncAt', Date.now())
      return { status: 'ok', pulledCards: pulled, pulledTexts: texts, pushedFiles: files.length, conflicts, warning }
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
      // подтверждение помнит СОСТАВ, а не только время: см. db.massDeleteConfirmed
      const pending: db.MassDeletePending = { ts: Date.now(), paths: e.paths }
      await db.kvSet('pendingMassDelete', pending)
      return { status: 'error', error: massDeleteMessage(e) }
    }
    return { status: 'error', error: e?.message ?? String(e) }
  }
}

async function pull(gh: GitHubClient, settings: Settings): Promise<{ headSha: string; treeSha: string; pulled: number; texts: number; conflicts: number; warning?: string }> {
  const headSha = await gh.getHead(settings.branch)
  const { treeSha } = await gh.getCommit(headSha)
  const { entries, truncated } = await gh.getTreeRecursive(treeSha)
  if (truncated) throw new Error('Дерево репозитория обрезано GitHub API — слишком большой repo')

  const local = await db.getAllCards()
  const shaByPath = new Map(local.map(c => [c.path, c.sha]))
  const remoteCards = new Map<string, TreeEntry>()
  const remoteJournals: TreeEntry[] = []
  const remoteReadings = new Map<string, TreeEntry>()
  for (const e of entries) {
    if (e.type !== 'blob') continue
    // карточки проверяются первыми: при экзотическом basePath (`Учёба`) каталог текстов попадает
    // и под isCardPath — тогда файл остаётся карточкой, как было до появления чтения, а не меняет
    // сущность от одной настройки
    if (isCardPath(e.path, settings.basePath)) remoteCards.set(e.path, e)
    else if (isJournalPath(e.path, settings.basePath)) remoteJournals.push(e)
    else if (isReadingPath(e.path, settings.basePath)) remoteReadings.set(e.path, e)
  }

  // сетевые запросы — ДО транзакции; снапшот используется только для sha-skip.
  // Блобы качаются пулом (CONCURRENCY параллельно), а не по одному: 150+ файлов
  // последовательно = 150+ round-trip. Порядок неважен — applyPull индексирует по path.
  const fetched: db.FetchedCard[] = []
  const conflictedFiles: string[] = []
  const toFetch = [...remoteCards].filter(([path, entry]) => shaByPath.get(path) !== entry.sha)
  await pooled(toFetch, async ([path, entry]) => {
    const text = await gh.getBlobText(entry.sha)
    const remote = parseMd(text)
    // git-конфликт-маркеры (watcher слил криво) — карантин, даже если YAML случайно распарсился
    const conflicted = hasConflictMarkers(text)
    if (conflicted) conflictedFiles.push(path.split('/').pop()!)
    fetched.push({ path, sha: entry.sha, fm: remote.fm, body: remote.body, broken: conflicted ? 1 : remote.broken })
  })
  // подтверждение массового удаления: второй Синк вскоре после предупреждения И тот же состав
  // удаляемого. Проверку состава делает applyPull — только он знает, что удаляется на самом деле.
  const pending = await db.kvGet<db.MassDeletePending>('pendingMassDelete')
  const conflicts = await db.applyPull(fetched, new Set(remoteCards.keys()), mergeCard, pending)
  // подтверждение одноразовое: applyPull дошёл до конца, значит либо удаление применено, либо
  // предохранитель не сработал вовсе — в обоих случаях старому разрешению висеть незачем
  if (pending) await db.kvSet('pendingMassDelete', null)
  /* Тексты для чтения приходят тем же pull-ом и тем же каналом, что карточки: отдельной кнопки
     «загрузить тексты» нет намеренно — материал, за которым надо ходить отдельно, не читают.
     Скачиваем только изменившиеся (sha-skip), как карточки.

     Конфликт-маркеры карантинят и текст, но по другой причине, чем у карточки: затирать чужую
     работу здесь нечем (приложение тексты не пишет), зато показывать <<<<<<< посреди абзаца
     ученику незачем — пусть лучше текст честно отсутствует до починки. */
  const localReadings = await db.getAllReadings()
  const readingSha = new Map(localReadings.map(r => [r.path, r.sha]))
  const fetchedReadings: ReadingRec[] = []
  const toFetchReadings = [...remoteReadings].filter(([path, entry]) => readingSha.get(path) !== entry.sha)
  await pooled(toFetchReadings, async ([path, entry]) => {
    const text = await gh.getBlobText(entry.sha)
    const remote = parseMd(text)
    const conflicted = hasConflictMarkers(text)
    if (conflicted) conflictedFiles.push(path.split('/').pop()!)
    fetchedReadings.push({ path, sha: entry.sha, fm: remote.fm, body: remote.body, broken: conflicted ? 1 : remote.broken })
  })
  /* Удаление текста из репозитория убирает локальную копию текста — и НИЧЕГО больше:
     отметки незнакомых слов и строки прочтения лежат в журнале, который эта операция
     не открывает (db.readingsDeletionPlan, там же цена решения). */
  await db.applyReadingsPull(fetchedReadings, new Set(remoteReadings.keys()))

  const warning = conflictedFiles.length
    ? `⚠️ Git-конфликт в: ${conflictedFiles.join(', ')} — файлы в карантине, почините <<<<<<< в vault`
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

  // манифест названий уровней (_уровни.md) — под фильтр isCardPath не попадает (префикс _),
  // тянем адресно и кэшируем по sha, чтобы не перекачивать каждый pull
  const manifestPath = `${settings.basePath}/_уровни.md`
  const manifestEntry = entries.find(e => e.type === 'blob' && e.path === manifestPath)
  if (manifestEntry) {
    const prevSha = await db.kvGet<string>('levelsSha')
    if (prevSha !== manifestEntry.sha) {
      const text = await gh.getBlobText(manifestEntry.sha)
      const { fm } = parseMd(text)
      const names: Record<string, string> = {}
      if (fm.levels && typeof fm.levels === 'object' && !Array.isArray(fm.levels)) {
        for (const [k, v] of Object.entries(fm.levels)) names[String(k)] = String(v)
      }
      await db.kvSet('levelNames', names)
      await db.kvSet('levelsSha', manifestEntry.sha)
    }
  }

  // история метрик (_метрики.ndjson) — под isJournalPath не попадает (префикс _), тянем адресно
  // и кэшируем по sha, чтобы приложение видело ряд, накопленный другими устройствами/днями
  const metricsPath = metricsPathOf(settings.basePath)
  const metricsEntry = entries.find(e => e.type === 'blob' && e.path === metricsPath)
  if (metricsEntry) {
    const prevSha = await db.kvGet<string>('metricsSha')
    if (prevSha !== metricsEntry.sha) {
      const text = await gh.getBlobText(metricsEntry.sha)
      await db.kvSet('metricsText', text)
      await db.kvSet('metricsSha', metricsEntry.sha)
    }
  }

  await db.kvSet('lastRemoteCommit', headSha)
  await db.kvSet('lastSyncAt', Date.now())
  return { headSha, treeSha, pulled: fetched.length, texts: fetchedReadings.length, conflicts, warning }
}
