import { useSyncExternalStore } from 'react'
import { type Grade, type Card as FsrsCard } from 'ts-fsrs'
import * as db from './db'
import { sync, type SyncStatus } from './sync'
import { cardView, fsrsFromFm, fsrsToFm } from './yamlfm'
import { makeScheduler } from './scheduler'
import { dayKey, isoLocal } from './daytime'
import { newId } from './journal'
import type { CardRec, CardView, JournalRec, Screen, SessionResult, Settings } from './types'
import { DEFAULT_SETTINGS } from './types'

const SETTINGS_KEY = 'sat-srs-settings'

interface AppState {
  ready: boolean
  screen: Screen
  settings: Settings
  cards: CardRec[]
  journal: JournalRec[]
  syncStatus: SyncStatus
  syncError: string
  lastSyncAt: number | null
  session: SessionResult | null
}

let state: AppState = {
  ready: false,
  screen: 'home',
  settings: loadSettings(),
  cards: [],
  journal: [],
  syncStatus: 'idle',
  syncError: '',
  lastSyncAt: null,
  session: null
}

const listeners = new Set<() => void>()

function emit() {
  state = { ...state }
  listeners.forEach(l => l())
}

export function useApp(): AppState {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => listeners.delete(l) },
    () => state
  )
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(s: Settings) {
  state.settings = s
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  emit()
}

export function setScreen(s: Screen) {
  state.screen = s
  emit()
}

export async function init() {
  state.cards = await db.getAllCards()
  state.journal = await db.getAllJournal()
  state.lastSyncAt = (await db.kvGet<number>('lastSyncAt')) ?? null
  state.ready = true
  if (!state.settings.pat) state.screen = 'settings'
  emit()
  if (state.settings.pat) void startSync()

  window.addEventListener('online', () => void startSync())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.settings.pat) {
      const stale = !state.lastSyncAt || Date.now() - state.lastSyncAt > 5 * 60000
      if (stale && state.screen !== 'review') void startSync()
    }
  })
}

export async function startSync(): Promise<void> {
  if (!state.settings.pat) return
  state.syncStatus = 'syncing'
  emit()
  const res = await sync(state.settings)
  state.cards = await db.getAllCards()
  state.journal = await db.getAllJournal()
  state.lastSyncAt = (await db.kvGet<number>('lastSyncAt')) ?? state.lastSyncAt
  state.syncStatus = res.status
  state.syncError = res.error ?? ''
  emit()
}

export function views(): CardView[] {
  return state.cards.map(cardView)
}

/** Оценка карточки: FSRS → запись в файл (dirty) → строка журнала. Возвращает новое fsrs-состояние. */
export async function rateCard(view: CardView, grade: Grade, elapsedMs: number): Promise<FsrsCard> {
  const rec = state.cards.find(c => c.path === view.path)
  if (!rec) throw new Error(`Карточка не найдена: ${view.path}`)
  const f = makeScheduler(state.settings.requestRetention)
  const now = new Date()
  const prev = fsrsFromFm(rec.fm)
  const { card: next } = f.next(prev, now, grade)

  const updated: CardRec = { ...rec, fm: { ...rec.fm, fsrs: fsrsToFm(next) }, dirty: 1 }
  await db.putCard(updated)
  state.cards = state.cards.map(c => (c.path === rec.path ? updated : c))

  const line: JournalRec = {
    id: newId(),
    type: 'review',
    ts: isoLocal(now),
    day: dayKey(now),
    slug: view.slug,
    rating: grade,
    prev_state: prev.state,
    new_state: next.state,
    due: next.due.toISOString(),
    stability: Math.round(next.stability * 100) / 100,
    elapsed_ms: elapsedMs,
    synced: 0
  }
  await db.putJournal([line])
  state.journal = [...state.journal, line]
  emit()
  return next
}

export async function finishSession(r: SessionResult) {
  const now = new Date()
  const line: JournalRec = {
    id: newId(),
    type: 'session',
    ts: isoLocal(now),
    day: dayKey(now),
    dur_ms: r.durMs,
    reviews: r.reviews,
    new_seen: r.newSeen,
    acc: r.totalRev ? Math.round((r.passRev / r.totalRev) * 100) : null,
    queue_empty: r.queueEmpty,
    synced: 0
  }
  await db.putJournal([line])
  state.journal = [...state.journal, line]
  state.session = r
  state.screen = 'summary'
  emit()
  void startSync()
}

function slugify(word: string): string {
  return word.trim().toLowerCase().replace(/[^a-zа-яё0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || 'card'
}

export async function addCard(fields: { word: string; pos: string; context: string; meaning_ru: string; meaning_en: string; roots: string }): Promise<string> {
  const now = new Date()
  let slug = slugify(fields.word)
  const taken = new Set(state.cards.map(c => c.path))
  let path = `${state.settings.basePath}/${slug}.md`
  if (taken.has(path) && fields.pos) {
    slug = `${slug}-${slugify(fields.pos)}`
    path = `${state.settings.basePath}/${slug}.md`
  }
  let i = 2
  while (taken.has(path)) {
    path = `${state.settings.basePath}/${slug}-${i++}.md`
  }
  const fm: Record<string, any> = {
    type: 'card',
    word: fields.word.trim(),
    pos: fields.pos.trim(),
    meaning_en: fields.meaning_en.trim(),
    meaning_ru: fields.meaning_ru.trim(),
    context: fields.context.trim(),
    roots: fields.roots.trim(),
    my_sentence: '',
    source: 'manual',
    added: dayKey(now),
    suspended: false,
    fsrs: {
      state: 0,
      due: now.toISOString(),
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 0,
      reps: 0,
      lapses: 0,
      last_review: null
    }
  }
  const rec: CardRec = { path, sha: null, fm, body: '', dirty: 1 }
  await db.putCard(rec)
  state.cards = [...state.cards, rec]
  emit()
  void startSync()
  return path
}
