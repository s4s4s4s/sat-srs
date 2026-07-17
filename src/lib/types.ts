import type { Card as FsrsCard } from 'ts-fsrs'

/** Карточка = md-файл в vault. fm — полный frontmatter как есть (чужие поля сохраняем). */
export interface CardRec {
  path: string          // repo-относительный путь, напр. "Учёба/Карточки/corroborate.md"
  sha: string | null    // blob sha на момент последней синхронизации (null = ещё не в repo)
  fm: Record<string, any>
  body: string          // тело файла после frontmatter — не трогаем
  dirty: number         // 1 = есть несинхронизированные изменения
  broken?: number       // 1 = frontmatter не разобрался; карточку не трогаем и не пишем
}

/** Типизированное представление карточки для UI/планировщика. */
export interface CardView {
  path: string
  slug: string
  word: string
  pos: string
  context: string
  contexts: string[]    // все контексты (ротация между показами); context = первый
  meaning_en: string
  meaning_ru: string
  roots: string
  source: string
  kind: string          // vocab | error | grammar | …
  domain: string        // домен College Board (II/CS/EOI/SEC/ALG/AM/PSDA/GEO)
  choices: string[]     // авторские MC-варианты (error/grammar/math); пусто = дистракторы из колоды
  answerText: string    // правильный вариант для авторских choices
  answerNum: string     // числовой ответ (math): "15", "0.8", "4/5" — ввод с клавиатуры
  desmos: boolean       // задача решается через Desmos — бейдж в вопросе
  explain: string       // объяснение после ответа
  suspended: boolean
  fsrs: FsrsCard
  /** Управление/предлог (опционально): prep — ответ, prepContext — предложение с пропуском предлога */
  prep: string
  prepContext: string
  fsrsPrep: FsrsCard | null
}

/** Навык — отдельное знание со своим FSRS-графиком */
export type Skill = 'recall' | 'prep'

/** Формат упражнения: intro — знакомство с новым словом (показ без викторины) */
export type Format = 'intro' | 'reveal' | 'mc' | 'type' | 'prep'

/** Единица очереди: (карточка × навык) */
export interface StudyItem {
  view: CardView
  skill: Skill
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
  skill?: string       // recall | prep (отсутствует в старых строках = recall)
  format?: string      // intro | reveal | mc | type | prep
  correct?: boolean    // объективный результат (mc/type/prep); у reveal отсутствует
  cause?: string       // самоотчёт после ошибки: правило | слово | misread | логика | тайминг
  kind?: string        // тип карточки, если не vocab
  domain?: string      // домен College Board, если задан
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
  newPerLesson: number
  requestRetention: number
}

export const DEFAULT_SETTINGS: Settings = {
  pat: '',
  owner: 's4s4s4s',
  repo: 'second-brain',
  branch: 'master',
  basePath: 'Учёба/Карточки',
  newPerDay: 15,
  newPerLesson: 4,
  requestRetention: 0.9
}

export type Screen = 'home' | 'review' | 'summary' | 'add' | 'stats' | 'settings'

export interface SessionResult {
  day: string       // учебный день, зафиксированный на старте сессии (не в момент финиша)
  reviews: number
  newSeen: number
  again: number
  passRev: number   // прошедшие (rating>1) среди prev_state=2
  totalRev: number  // всего оценок карт в состоянии Review
  durMs: number
  queueEmpty: boolean
}
