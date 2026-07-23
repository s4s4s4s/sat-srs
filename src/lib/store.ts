import { useSyncExternalStore } from 'react'
import { State, Rating, type Grade, type Card as FsrsCard } from 'ts-fsrs'
import * as db from './db'
import { sync, syncIdle, type SyncStatus } from './sync'
import { GitHubClient, tokenExpiration } from './github'
import { cardView, fsrsFromKey, fsrsToFm } from './yamlfm'
import { makeScheduler, effectiveRetention, homeCounts, DUE_CAP, type Section } from './scheduler'
import { dayKey, isoLocal, setHomeOffset } from './daytime'
import { newId, newIntroducedOn } from './journal'
import type { CardRec, CardView, Format, JournalRec, Screen, SessionResult, Settings, StudyItem } from './types'
import { DEFAULT_SETTINGS } from './types'

const SETTINGS_KEY = 'sat-srs-settings'

interface AppState {
  ready: boolean
  screen: Screen
  sessionSection: Section
  sessionReviewOnly: boolean
  settings: Settings
  cards: CardRec[]
  journal: JournalRec[]
  syncStatus: SyncStatus
  syncError: string
  lastSyncAt: number | null
  tokenExpiresAt: string | null
  session: SessionResult | null
  levelNames: Record<string, string>
}

let state: AppState = {
  ready: false,
  screen: 'home',
  sessionSection: 'rw',
  sessionReviewOnly: false,
  settings: loadSettings(),
  cards: [],
  journal: [],
  syncStatus: 'idle',
  syncError: '',
  lastSyncAt: null,
  tokenExpiresAt: null,
  session: null,
  levelNames: {}
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
  setHomeOffset(s.homeOffset ? Number(s.homeOffset) : null)
  emit()
}

export function setScreen(s: Screen) {
  state.screen = s
  emit()
}

/** Старт урока в разделе; reviewOnly = только повторения, без ввода новых слов */
export function startLesson(section: Section, reviewOnly = false) {
  state.sessionSection = section
  state.sessionReviewOnly = reviewOnly
  state.screen = 'review'
  emit()
}

export async function init() {
  // настройки перечитываются здесь, а не только при загрузке модуля:
  // порядок инициализации не должен зависеть от порядка импортов
  state.settings = loadSettings()
  setHomeOffset(state.settings.homeOffset ? Number(state.settings.homeOffset) : null)
  // без persist iOS может выселить IndexedDB — вместе с несинхронизированными ревью
  if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {})
  try {
    state.cards = await db.getAllCards()
    state.journal = await db.getAllJournal()
    state.lastSyncAt = (await db.kvGet<number>('lastSyncAt')) ?? null
    state.levelNames = (await db.kvGet<Record<string, string>>('levelNames')) ?? {}
  } catch (e: any) {
    // локальная база не открылась (бывает на холодном старте WebKit) — не виснем на «Загрузка…»
    state.syncStatus = 'error'
    state.syncError = `Локальная база недоступна: ${e?.message ?? e}`
  }
  state.ready = true
  if (!state.settings.pat) state.screen = 'settings'
  emit()
  updateBadge()
  if (state.settings.pat) void startSync()

  window.addEventListener('online', () => {
    if (state.settings.pat && state.screen !== 'review') void startSync()
  })
  // каждый заход в приложение (foreground) — синк; в ревью нельзя (карточки под ногами)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') updateBadge()
    if (document.visibilityState === 'visible' && state.settings.pat) {
      const stale = !state.lastSyncAt || Date.now() - state.lastSyncAt > 30_000
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
  state.levelNames = (await db.kvGet<Record<string, string>>('levelNames')) ?? state.levelNames
  state.syncStatus = res.status
  state.syncError = res.error ?? res.warning ?? (res.conflicts ? `Конфликт имён с тьютором: ваша карточка сохранена с суффиксом -2 (${res.conflicts})` : '')
  state.tokenExpiresAt = tokenExpiration
  emit()
  updateBadge()
}

/**
 * Полная пересинхронизация (remote wins): локальный кэш стирается целиком и состояние
 * строится заново из репозитория — файл без fsrs-блока снова становится New.
 * Локальные несинканные оценки и правки при этом теряются: вызывать только по явному
 * подтверждению пользователя. Токен и настройки сохраняются (они в localStorage).
 * Возвращает число загруженных карточек.
 */
export async function fullResync(): Promise<number> {
  if (!state.settings.pat) throw new Error('Сначала подключите репозиторий.')
  // репозиторий проверяем ДО очистки: незачем оставлять приложение пустым,
  // если ветка недоступна или токен протух — сбрасывать будет уже нечего
  const gh = new GitHubClient(state.settings.pat, state.settings.owner, state.settings.repo)
  await gh.getHead(state.settings.branch)
  await syncIdle()
  state.syncStatus = 'syncing'
  state.syncError = ''
  emit()
  await db.clearLocalData()
  state.cards = []
  state.journal = []
  state.lastSyncAt = null
  emit()
  await startSync()
  // startSync ошибку не бросает — она оседает в syncStatus; для вызывающего это провал.
  // Приведение типа нужно, потому что TS помнит присвоенное выше 'syncing' и не знает про мутацию внутри startSync.
  if ((state.syncStatus as SyncStatus) !== 'ok') {
    throw new Error(state.syncError || 'Не удалось загрузить карточки — нажмите Синк.')
  }
  return state.cards.length
}

export function views(): CardView[] {
  return state.cards.map(cardView)
}

/** Актуальный журнал (для чтения после await, минуя снапшот useApp) */
export function currentJournal() {
  return state.journal
}

/** Несинхронизированные изменения: строки журнала + dirty-карточки */
export function unsyncedCount(): number {
  return state.journal.filter(j => !j.synced).length + state.cards.filter(c => c.dirty && !c.broken).length
}

/** Оценка учебной единицы (карточка × навык): FSRS → запись в свой fsrs-блок файла (dirty) → строка журнала. */
export async function rateItem(item: StudyItem, grade: Grade, elapsedMs: number, format: Format, correct?: boolean): Promise<{ card: FsrsCard; lineId: string }> {
  const rec = state.cards.find(c => c.path === item.view.path)
  if (!rec || rec.broken) throw new Error(`Карточка не найдена: ${item.view.path}`)
  const fsrsKey = item.skill === 'prep' ? 'fsrs_prep' : 'fsrs'
  const f = makeScheduler(effectiveRetention(state.settings.requestRetention))
  const now = new Date()
  const prev = fsrsFromKey(rec.fm, fsrsKey)
  let { card: next } = f.next(prev, now, grade)
  // потолок интервалов: всё возвращается до экзамена; окно 5–14 дней перед DUE_CAP (31.10),
  // взвешено по стабильности — прочные карточки раньше, хрупкие ближе к 31.10; без свалки в одну неделю
  if (next.state === State.Review && now < DUE_CAP && next.due > DUE_CAP) {
    const span = Math.min(14, Math.max(5, Math.round(next.stability / 10)))
    const due = new Date(DUE_CAP.getTime() - Math.floor(Math.random() * span) * 86400_000)
    next = { ...next, due, scheduled_days: Math.max(1, Math.round((due.getTime() - now.getTime()) / 86400_000)) }
  }

  // строка журнала строится ДО записи карточки: любой сбой здесь не рассинхронизирует БД и UI
  const line: JournalRec = {
    id: newId(),
    v: 1,
    type: 'review',
    ts: isoLocal(now),
    day: dayKey(now),
    slug: item.view.slug,
    skill: item.skill,
    format,
    ...(correct === undefined ? {} : { correct }),
    ...(item.view.kind !== 'vocab' ? { kind: item.view.kind } : {}),
    ...(item.view.domain ? { domain: item.view.domain } : {}),
    rating: grade,
    prev_state: prev.state,
    new_state: next.state,
    due: next.due.toISOString(),
    stability: Math.round(next.stability * 100) / 100,
    elapsed_ms: elapsedMs,
    synced: 0
  }

  const fmPatch: Record<string, any> = { [fsrsKey]: fsrsToFm(next) }
  // день первого показа слова — фиксируется один раз при первой оценке recall из New
  if (item.skill === 'recall' && prev.state === State.New && !rec.fm.first_seen) {
    fmPatch.first_seen = dayKey(now)
  }
  // пиявка: +6 провалов сверх прошлого бюджета — повторение не лечит интерференцию,
  // нужна переформулировка тьютором; после снятия флага бюджет начинается заново
  const leechBase = Number(rec.fm.leech_lapses) || 0
  if (grade === Rating.Again && next.lapses >= leechBase + 6 && !rec.fm.leech) {
    fmPatch.leech = dayKey(now)
    fmPatch.leech_lapses = next.lapses
  }
  const updated: CardRec = { ...rec, fm: { ...rec.fm, ...fmPatch }, dirty: 1 }
  await db.putCard(updated)
  state.cards = state.cards.map(c => (c.path === rec.path ? updated : c))
  await db.putJournal([line])
  state.journal = [...state.journal, line]
  emit()
  updateBadge()
  return { card: next, lineId: line.id }
}

/**
 * Знакомство с новым словом БЕЗ оценки FSRS: «Продолжить» на интро — это показ, не вспоминание.
 * Фиксирует first_seen и строку журнала format:intro; первый настоящий рейтинг даст отработка.
 */
export async function markIntroduced(item: StudyItem): Promise<void> {
  const rec = state.cards.find(c => c.path === item.view.path)
  if (!rec || rec.broken) return
  const now = new Date()
  if (!rec.fm.first_seen) {
    const updated: CardRec = { ...rec, fm: { ...rec.fm, first_seen: dayKey(now) }, dirty: 1 }
    await db.putCard(updated)
    state.cards = state.cards.map(c => (c.path === rec.path ? updated : c))
  }
  const line: JournalRec = {
    id: newId(),
    v: 1, type: 'review', ts: isoLocal(now), day: dayKey(now),
    slug: item.view.slug, skill: item.skill, format: 'intro', synced: 0
  }
  await db.putJournal([line])
  state.journal = [...state.journal, line]
  emit()
}

/** Идеальный день: всё повторено вовремя, очередь пуста — день зачитывается сам, без сессии */
export async function creditEmptyDay(): Promise<void> {
  const today = dayKey()
  if (state.journal.some(l => l.day === today && l.type === 'session' && l.queue_empty)) return
  const now = new Date()
  const line: JournalRec = {
    id: newId(),
    v: 1, type: 'session', ts: isoLocal(now), day: today,
    dur_ms: 0, reviews: 0, new_seen: 0, acc: null, queue_empty: true, synced: 0
  }
  await db.putJournal([line])
  state.journal = [...state.journal, line]
  emit()
  updateBadge()
  void startSync()
}

/** Самоотчёт о причине ошибки — дописывается в уже созданную строку журнала */
export async function setCause(lineId: string, cause: string): Promise<void> {
  const line = state.journal.find(l => l.id === lineId)
  if (!line) return
  const updated: JournalRec = { ...line, cause, synced: 0 }
  await db.putJournal([updated])
  state.journal = state.journal.map(l => (l.id === lineId ? updated : l))
  emit()
}

/** Бейдж на иконке: сколько сейчас к повторению (без новых) */
function updateBadge() {
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void> }
  if (typeof nav.setAppBadge !== 'function') return
  try {
    const budget = Math.max(0, state.settings.newPerDay - newIntroducedOn(state.journal, dayKey()))
    const c = homeCounts(state.cards.map(cardView), budget)
    void nav.setAppBadge(c.learnDue + c.revDue).catch(() => {})
  } catch { /* ignore */ }
}

export async function finishSession(r: SessionResult) {
  const now = new Date()
  const line: JournalRec = {
    id: newId(),
    v: 1,
    type: 'session',
    ts: isoLocal(now),
    // день из старта сессии: финиш в 04:10 не должен уносить queue_empty на следующий учебный день
    day: r.day || dayKey(now),
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
  updateBadge()
  void startSync()
}

function slugify(word: string): string {
  return word.trim().toLowerCase().replace(/[^a-zа-яё0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || 'card'
}

export async function addCard(fields: { word: string; pos: string; context: string; meaning_ru: string; meaning_en: string; roots: string }): Promise<string> {
  const now = new Date()
  const wordNorm = fields.word.trim().toLowerCase()
  const dup = state.cards.find(c => !c.broken && String(c.fm.word ?? '').trim().toLowerCase() === wordNorm)
  if (dup) throw new Error(`«${fields.word.trim()}» уже есть в колоде (${dup.path.split('/').pop()})`)
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
  // level НЕ проставляется здесь: уровень = ступень развития слова по содержанию, его назначает
  // тьютор, а не дата добавления. Слово из приложения ждёт разметки тьютором (отчёт ловит «vocab без level»).
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
