import { useSyncExternalStore } from 'react'
import { State, type Grade, type Card as FsrsCard } from 'ts-fsrs'
import * as db from './db'
import { sync, syncIdle, type SyncStatus } from './sync'
import { GitHubClient, tokenExpiration } from './github'
import { cardView, fsrsFromKey, fsrsToFm } from './yamlfm'
import { makeScheduler, effectiveRetention, holdOnIntroDay, homeCounts, isLevelled, newBudgetTotal, DUE_CAP, type Section, type TypeVerdict } from './scheduler'
import { parseMetrics, isLeech, type MetricSnapshot } from './metrics'
import { dayKey, isoLocal, setHomeOffset, endOfStudyDay } from './daytime'
import { newId, matureRetention, sessionAccuracy, READ_CAP_MINUTES } from './journal'
import type { CardRec, CardView, Format, JournalRec, Screen, SessionResult, Settings, StudyItem } from './types'
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from './types'
import { setSoundEnabled } from './sound'

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
  metricsHistory: MetricSnapshot[]
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
  levelNames: {},
  metricsHistory: []
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

/* Миграции настроек.
   Ключ — версия, ДО которой мигрируем. Каждая получает уже слитый с дефолтами
   объект и возвращает исправленный. Правка дефолта сама по себе до устройства
   не доедет (сохранённое перекрывает дефолты), поэтому всё, что обязано
   примениться принудительно, живёт здесь. */
const SETTINGS_MIGRATIONS: Record<number, (s: Settings) => Settings> = {
  /* → v2 (05.08.2026). Два поля, которые пользователь не мог починить руками,
     потому что не знал о них: окно паузы до 16.08 (приложение разрешало не
     заниматься при 59 днях до экзамена) и московский пояс после переезда в
     Ереван (граница учебного дня 04:00 съезжала на час). */
  2: s => ({
    ...s,
    pauseFrom: DEFAULT_SETTINGS.pauseFrom,
    pauseTo: DEFAULT_SETTINGS.pauseTo,
    homeOffset: DEFAULT_SETTINGS.homeOffset
  }),
  /* → v3 (17.08.2026). Ввод слова становится шагом ротации Review (C8). Тумблер
     выключался 05.08 под сломанную руку, лежит в сохранённых настройках телефона
     и без принудительной миграции остался бы выключенным навсегда — ровно тот
     класс поля, ради которого версия и заведена. */
  3: s => ({ ...s, typing: DEFAULT_SETTINGS.typing }),
  /* → v4 (17.08.2026). Дневная норма новых слов — 8, а не прежние 15. Именно ввод
     пачками уже спровоцировал половину нынешних проблем: 27.07 в колоду вошло 187
     показов за один день, стабильность просевших карточек не успела подрасти ни у
     одной. План требует восьми в день; правки одного DEFAULT_SETTINGS для этого не
     хватает — сохранённые 15 лежат в телефоне и без миграции перекрывали бы новый
     дефолт навсегда (тот же класс поля, что и newPerDay/typing выше). */
  4: s => ({ ...s, newPerDay: DEFAULT_SETTINGS.newPerDay }),
  /* → v5 (17.08.2026). Колода переезжает из личного вальта (s4s4s4s/second-brain,
     master) в отдельный приватный репозиторий s4s4s4s/sat-deck, ветка main — токен
     на телефоне носил scope на весь вальт, после переезда он выдан только на колоду.
     Пути внутри репозитория те же (basePath не меняется), меняются только repo и
     branch. Без принудительной миграции сохранённые в телефоне старые repo/branch
     перекрывали бы новый дефолт навсегда, и устройство продолжало бы стучаться в
     репозиторий, где токен уже не действует (тот же класс поля, что и выше). Токен
     (`pat`) миграция не трогает — его вводят руками. */
  5: s => ({ ...s, repo: DEFAULT_SETTINGS.repo, branch: DEFAULT_SETTINGS.branch }),
  /* Звук появился 20.08.2026. Без миграции сохранённый объект настроек перекрыл бы
     дефолт навсегда, и в уже установленном PWA урок остался бы немым. */
  6: s => ({ ...s, sound: DEFAULT_SETTINGS.sound }),
  /* → v7 (20.08.2026). Кнопка «Почему?» перестала ходить в платный API Anthropic:
     разбор пишет Claude Code на домашней машине под подпиской. Поле `anthropicKey`
     удаляется, а не просто перестаёт читаться: ключ от платного API, оставшийся
     лежать в устройстве без применения, — это утечка, которая ждёт своего часа. */
  7: s => {
    /* Только удаление: `coachToken` здесь не трогаем. Поля до этой версии не
       существовало, пустую строку ему уже дал разлив дефолтов, — а насильно
       сбросить его значило бы стирать токен, который пользователь только что
       вписал (и который, в отличие от полей выше, приложение не знает само). */
    const { anthropicKey, ...без } = s as Settings & { anthropicKey?: string }
    void anthropicKey
    return без as Settings
  }
}

export function migrateSettings(saved: Partial<Settings>): Settings {
  let s: Settings = { ...DEFAULT_SETTINGS, ...saved }
  const from = Number.isFinite(saved.v as number) ? Number(saved.v) : 1
  for (let v = from + 1; v <= SETTINGS_VERSION; v++) {
    const m = SETTINGS_MIGRATIONS[v]
    if (m) s = m(s)
  }
  return { ...s, v: SETTINGS_VERSION }
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const s = migrateSettings(JSON.parse(raw))
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
      return s
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(s: Settings) {
  state.settings = s
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  setHomeOffset(s.homeOffset ? Number(s.homeOffset) : null)
  setSoundEnabled(s.sound)
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
  setSoundEnabled(state.settings.sound)
  // без persist iOS может выселить IndexedDB — вместе с несинхронизированными ревью
  if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {})
  try {
    state.cards = await db.getAllCards()
    state.journal = await db.getAllJournal()
    state.lastSyncAt = (await db.kvGet<number>('lastSyncAt')) ?? null
    state.levelNames = (await db.kvGet<Record<string, string>>('levelNames')) ?? {}
    state.metricsHistory = parseMetrics((await db.kvGet<string>('metricsText')) ?? '')
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
  state.metricsHistory = parseMetrics((await db.kvGet<string>('metricsText')) ?? '')
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

/** Настройки вне React — нужны на старте, до монтирования дерева (заход `?go=1`). */
export function currentSettings(): Settings {
  return state.settings
}

/** Несинхронизированные изменения: строки журнала + dirty-карточки */
export function unsyncedCount(): number {
  return state.journal.filter(j => !j.synced).length + state.cards.filter(c => c.dirty && !c.broken).length
}

/** Оценка учебной единицы (карточка × навык): FSRS → запись в свой fsrs-блок файла (dirty) → строка журнала. */
export async function rateItem(item: StudyItem, grade: Grade, elapsedMs: number, format: Format, verdict?: TypeVerdict, gaveUp?: boolean): Promise<{ card: FsrsCard; lineId: string }> {
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

  // point 1: слово, введённое сегодня, не уходит в Review внутри того же учебного
  // дня. Само правило и цена ошибки в нём — в holdOnIntroDay (scheduler.ts).
  const introDay = rec.fm.first_seen ?? (prev.state === State.New ? dayKey(now) : null)
  next = holdOnIntroDay(prev, next, now, introDay)

  // строка журнала строится ДО записи карточки: любой сбой здесь не рассинхронизирует БД и UI
  const line: JournalRec = {
    id: newId(),
    v: 1,
    type: 'review',
    ts: isoLocal(now),
    ms: now.getMilliseconds(),
    day: dayKey(now),
    slug: item.view.slug,
    skill: item.skill,
    format,
    ...(verdict === undefined ? {} : { correct: verdict !== 'wrong' }),
    // опечатка (Левенштейн) при вводе — не незнание: помечаем, чтобы исключить из retention
    ...(verdict === 'typo' ? { typo: true } : {}),
    // C10: синоним вместо загаданного слова — тоже не незнание, и тоже не чистый сигнал retention
    ...(verdict === 'twin' ? { twin: true } : {}),
    // C3/C4: «не помню» / пустой ввод — честное признание незнания, семантически ≠ неверный ответ
    ...(gaveUp ? { gave_up: true } : {}),
    ...(item.view.kind !== 'vocab' ? { kind: item.view.kind } : {}),
    ...(item.view.domain ? { domain: item.view.domain } : {}),
    // ступень слова на момент показа — чтобы retention по ступеням не врал после переразметки
    ...(isLevelled(item.view) && item.view.level < 999 ? { level: item.view.level } : {}),
    rating: grade,
    prev_state: prev.state,
    new_state: next.state,
    due: next.due.toISOString(),
    stability: Math.round(next.stability * 100) / 100,
    // плановый интервал FSRS — точный бакет интервала в retentionByInterval без реконструкции из ts
    scheduled_days: next.scheduled_days,
    elapsed_ms: elapsedMs,
    synced: 0
  }

  const fmPatch: Record<string, any> = { [fsrsKey]: fsrsToFm(next) }
  // день первого показа слова — фиксируется один раз при первой оценке recall из New
  if (item.skill === 'recall' && prev.state === State.New && !rec.fm.first_seen) {
    fmPatch.first_seen = dayKey(now)
  }
  /* Пиявка: общий предикат isLeech (metrics.ts), тот же, что уже читает report.ts —
     много повторов при неподросшей стабильности. Прежнее условие здесь было другим
     и несовместимым с отчётным: `lapses >= leech_lapses + 6`, а lapses растёт только
     при провале карточки из состояния Review — максимум по всей колоде был 2. Порог
     +6 был недостижим НИКОГДА: плашка «Пиявка» не показалась ни разу за всю историю,
     поле leech пусто во всех 450 карточках, тьютор сигнала не получал, а 14 слов,
     которые отчёт считает пиявками, съели 210 показов из 486 (43% всей работы SRS).
     Смотрим на next (состояние ПОСЛЕ этой оценки), а не prev — иначе флаг ставился бы
     на шаг позже настоящего порога. */
  if (isLeech(next) && !rec.fm.leech) {
    fmPatch.leech = dayKey(now)
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
 * Пишет только строку журнала format:intro; первый настоящий рейтинг даст отработка.
 *
 * A7: `first_seen` здесь НЕ ставится. Раньше ставился — и слово, знакомство которого урок показал
 * и бросил без единой отработки, оставалось New с датой первого показа: в отчёте оно выглядело
 * введённым, а по факту не было выучено (25.07: `hypothesis` получил три знакомства за 40 секунд
 * и ни одной оценки). Дату первого показа фиксирует rateItem при первой оценке recall из New.
 */
export async function markIntroduced(item: StudyItem): Promise<void> {
  const rec = state.cards.find(c => c.path === item.view.path)
  if (!rec || rec.broken) return
  const now = new Date()
  const line: JournalRec = {
    id: newId(),
    v: 1, type: 'review', ts: isoLocal(now), ms: now.getMilliseconds(), day: dayKey(now),
    slug: item.view.slug, skill: item.skill, format: 'intro', synced: 0
  }
  await db.putJournal([line])
  state.journal = [...state.journal, line]
  emit()
}

/**
 * C2: карточка, дважды проваленная за одну сессию, откладывается — её due переносится
 * на начало следующего учебного дня, чтобы она не крутилась в пределах текущего урока.
 * Это пост-фактум коррекция срока над уже записанным FSRS-состоянием (E1: формулы не трогаем),
 * рейтинга и строки журнала не пишет — оценка провала уже занесена rateItem.
 */
export async function deferItemToNextDay(item: StudyItem): Promise<void> {
  const rec = state.cards.find(c => c.path === item.view.path)
  if (!rec || rec.broken) return
  const fsrsKey = item.skill === 'prep' ? 'fsrs_prep' : 'fsrs'
  const now = new Date()
  const prev = fsrsFromKey(rec.fm, fsrsKey)
  const due = endOfStudyDay(now)
  if (prev.due.getTime() >= due.getTime()) return // уже за пределами дня — переносить нечего
  const next: FsrsCard = { ...prev, due, scheduled_days: Math.max(1, Math.round((due.getTime() - now.getTime()) / 86400_000)) }
  const updated: CardRec = { ...rec, fm: { ...rec.fm, [fsrsKey]: fsrsToFm(next) }, dirty: 1 }
  await db.putCard(updated)
  state.cards = state.cards.map(c => (c.path === rec.path ? updated : c))
  emit()
  updateBadge()
}

/** Идеальный день: всё повторено вовремя, очередь пуста — день зачитывается сам, без сессии */
/** Отметить чтение: вторая половина защищённого минимума.
 *
 *  Инструмента для неё не было вовсе, и в «Метриках» семь недель подряд стоит
 *  «0/7 (не трекается)». Мерить нечем — значит и делать нечего: невидимая
 *  половина дисциплины отмирает первой, что и произошло.
 *
 *  Строка пишется в тот же журнал, что и повторы, поэтому попадает в вальт
 *  обычной синхронизацией и оказывается видна разбору наравне с SRS. */
export async function logReading(minutes: number, what = ''): Promise<void> {
  const min = Math.round(Math.min(Math.max(minutes, 1), READ_CAP_MINUTES))
  const now = new Date()
  const line: JournalRec = {
    id: newId(),
    v: 1, type: 'read', ts: isoLocal(now), ms: now.getMilliseconds(), day: dayKey(),
    read_min: min, what: what.trim().slice(0, 120), synced: 0
  }
  await db.putJournal([line])
  state.journal = [...state.journal, line]
  emit()
  updateBadge()
  void startSync()
}

/* `creditEmptyDay` удалена 05.08.2026.
   Она писала в журнал строку session с `reviews: 0, dur_ms: 0, queue_empty: true`
   и вызывалась из рендера главного экрана. Девятнадцать дней серии из сорока
   одного закрыты именно ей — то есть открытием приложения. Добитая очередь
   по-прежнему засчитывает день, но только настоящей строкой session из
   законченного урока (см. `journal.emptyDays`, где стоит `reviews > 0`). */

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
    const все = state.cards.map(cardView)
    const budget = newBudgetTotal(все, state.settings.newPerDay, state.journal, dayKey())
    const c = homeCounts(все, budget)
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
    // D1: миллисекунды — тайбрейк внутри секунды, иначе строка session могла встать в файле
    // раньше последней review своей сессии (порядок задавала выдача IndexedDB по uuid)
    ms: now.getMilliseconds(),
    // день из старта сессии: финиш в 04:10 не должен уносить queue_empty на следующий учебный день
    day: r.day || dayKey(now),
    dur_ms: r.durMs,
    reviews: r.reviews,
    new_seen: r.newSeen,
    acc: matureRetention(r),
    // точность за весь урок и число провалов — то, что показывается на итогах; `acc` остаётся
    // ретеншном по зрелым карточкам, чтобы старые строки и метрики читались как раньше (D3)
    acc_all: sessionAccuracy(r),
    again: r.again,
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
