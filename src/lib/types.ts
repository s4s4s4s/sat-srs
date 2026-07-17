import type { Card as FsrsCard } from 'ts-fsrs'

/** Карточка = md-файл в vault. fm — полный frontmatter как есть (чужие поля сохраняем). */
export interface CardRec {
  path: string          // repo-относительный путь, напр. "Учёба/Карточки/corroborate.md"
  sha: string | null    // blob sha на момент последней синхронизации (null = ещё не в repo)
  fm: Record<string, any>
  body: string          // тело файла после frontmatter — не трогаем
  dirty: number         // 1 = есть несинхронизированные изменения
}

/** Типизированное представление карточки для UI/планировщика. */
export interface CardView {
  path: string
  slug: string
  word: string
  pos: string
  context: string
  meaning_en: string
  meaning_ru: string
  roots: string
  source: string
  suspended: boolean
  fsrs: FsrsCard
}

/** Строка журнала ревью (ndjson в vault). */
export interface JournalLine {
  id: string
  type: 'review' | 'session'
  ts: string   // ISO с локальным смещением
  day: string  // локальный день с rollover 04:00, YYYY-MM-DD — фиксируется при записи
  // review:
  slug?: string
  rating?: number      // 1 Again · 2 Hard · 3 Good · 4 Easy
  prev_state?: number  // 0 New · 1 Learning · 2 Review · 3 Relearning
  new_state?: number
  due?: string
  stability?: number
  elapsed_ms?: number
  // session:
  dur_ms?: number
  reviews?: number
  new_seen?: number
  acc?: number | null
  queue_empty?: boolean
}

export interface JournalRec extends JournalLine {
  synced: number // 1 = уже в repo
}

export interface Settings {
  pat: string
  owner: string
  repo: string
  branch: string
  basePath: string
  newPerDay: number
  requestRetention: number
}

export const DEFAULT_SETTINGS: Settings = {
  pat: '',
  owner: 's4s4s4s',
  repo: 'second-brain',
  branch: 'master',
  basePath: 'Учёба/Карточки',
  newPerDay: 15,
  requestRetention: 0.9
}

export type Screen = 'home' | 'review' | 'summary' | 'add' | 'stats' | 'settings'

export interface SessionResult {
  reviews: number
  newSeen: number
  again: number
  passRev: number   // прошедшие (rating>1) среди prev_state=2
  totalRev: number  // всего оценок карт в состоянии Review
  durMs: number
  queueEmpty: boolean
}
