import { useSyncExternalStore } from 'react'
import { State, type Grade, type Card as FsrsCard } from 'ts-fsrs'
import * as db from './db'
import { sync, syncIdle, type SyncStatus } from './sync'
import { GitHubClient, tokenExpiration } from './github'
import { cardView, fsrsFromKey, fsrsToFm, readingView, slugFromPath } from './yamlfm'
import { makeScheduler, effectiveRetention, holdExerciseToNextDay, holdOnIntroDay, homeCounts, isLevelled, newBudgetTotal, DUE_CAP, type Section, type TypeVerdict } from './scheduler'
import { parseMetrics, isLeech, LEECH_STABILITY_DAYS, type MetricSnapshot } from './metrics'
import { dayKey, isoLocal, setHomeOffset, endOfStudyDay } from './daytime'
import {
  newId, matureRetention, sessionAccuracy, cardTimeCap, READ_CAP_MINUTES,
  readingSrc, isMarked, markCount, readingPassed, deckHasWord, normWord, MARK_SENTENCE_MAX
} from './journal'
import type { CardRec, CardView, Format, JournalRec, ReadingRec, ReadingView, Screen, SessionResult, Settings, StudyItem } from './types'
import { DEFAULT_SETTINGS } from './types'
import { NEW_PER_DAY } from './norms'
import { setSoundEnabled } from './sound'
import { migrateSettings } from './settings'

const SETTINGS_KEY = 'sat-srs-settings'

interface AppState {
  ready: boolean
  screen: Screen
  sessionSection: Section
  sessionReviewOnly: boolean
  /* Урок сверх нормы: квота новых берётся из максимума дня, а не из оптимума.
     Взводится только с главного экрана кнопкой «Ещё», когда повторять нечего, а
     оптимум ввода уже выбран, — чтобы день не упирался в стену при экзамене на
     носу. Оценки такого урока пишутся как обычные повторения: это занятие, а не
     тренажёр. */
  sessionOverNorm: boolean
  settings: Settings
  cards: CardRec[]
  /* Тексты для чтения — отдельный список, а не подмножество cards: у текста нет FSRS-графика
     и он не участвует ни в очереди, ни в норме ввода (см. ReadingRec в types.ts). */
  readings: ReadingRec[]
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
  sessionOverNorm: false,
  settings: loadSettings(),
  cards: [],
  readings: [],
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

/* Перезагрузка после обновления, отложенная до конца урока.

   Service worker стоит в режиме autoUpdate, и workbox по умолчанию сам зовёт
   location.reload(), как только новый билд забрал контроль. Посреди урока это
   стоило целой сессии: уже поставленные оценки переживают перезагрузку (их
   пишет rateItem), но finishSession не вызывается, и строки type: session за
   этот урок в журнале не появляется. Дальше по цепочке — день не зачитывается
   добитой очередью, точность урока не доходит до тьютора, а forcedTodaySlugs
   делит день на блоки именно строками session и склеивает два урока в один:
   слово недосчитывает отработку и приходит в лишние уроки. */
let pendingReload: (() => void) | null = null

/** Экраны, с которых перезагружать нельзя: урок в ходу или его итоги ещё не прочитаны. */
function reloadBlocked(): boolean {
  return state.screen === 'review' || state.screen === 'summary'
}

function emit() {
  state = { ...state }
  listeners.forEach(l => l())
  if (pendingReload && !reloadBlocked()) {
    const reload = pendingReload
    pendingReload = null
    reload()
  }
}

/**
 * Отложить перезагрузку страницы до выхода из урока.
 *
 * Вне урока перезагружает сразу — обновление не должно ждать без причины.
 * Если ученик так и не вышел из урока, перезагрузки не будет вовсе: новый
 * service worker уже активен, и следующий запуск приложения возьмёт свежий
 * код сам. Потерять обновление здесь дешевле, чем потерять урок.
 */
export function deferReloadUntilLessonEnds(reload: () => void) {
  if (!reloadBlocked()) { reload(); return }
  pendingReload = reload
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

/**
 * Старт урока в разделе.
 * reviewOnly — только повторения, без ввода новых слов;
 * overNorm — урок сверх дневного оптимума: квота новых идёт до максимума дня.
 */
export function startLesson(section: Section, reviewOnly = false, overNorm = false) {
  state.sessionSection = section
  state.sessionReviewOnly = reviewOnly
  state.sessionOverNorm = overNorm
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
    state.readings = await db.getAllReadings()
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
  state.readings = await db.getAllReadings()
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

/** Тексты для чтения — типизированные виды. Битый frontmatter отсеивается: показывать нечего. */
export function readingViews(): ReadingView[] {
  return state.readings.map(readingView).filter(v => !v.broken)
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

/**
 * Потолок интервала: всё выученное обязано вернуться хотя бы раз до DUE_CAP (scheduler.ts) —
 * иначе карточка получает срок за первой попыткой и до экзамена не показывается ни разу.
 *
 * Срок разыгрывается в окне шириной `span` дней, упирающемся в DUE_CAP, и ширина растёт со
 * стабильностью: прочные карточки уезжают раньше, хрупкие жмутся к самому потолку, и зрелая
 * часть колоды не сваливается в один день. Замысел прежний, сломана была реализация.
 *
 * Окно обязано лежать МЕЖДУ `now` и потолком. Прежняя версия отсчитывала только назад от
 * DUE_CAP и с `now` не сверялась вовсе: 24.09 при стабильности 120 карточка получала срок
 * 15–18.09 — на 5–8 дней в прошлом, и так в 86% розыгрышей того дня. Ровно за две недели до
 * первой попытки вся зрелая часть колоды разом стала бы просроченной. Побочно `scheduled_days`
 * писался как `Math.max(1, …)` от отрицательного числа, то есть единицей, и уезжал в журнал:
 * ретеншн по бакетам интервала предпочитает это поле фактическому разрыву, и карточка с
 * настоящим интервалом в 40 дней попадала в бакет «1 день».
 *
 * Нижняя граница окна — начало следующего учебного дня: FSRS только что сказал, что сегодня
 * карточку показывать не нужно, и зажим не повод возвращать её в сегодняшнюю очередь.
 * Если до потолка осталось меньше суток, разыгрывать нечего — карточка получает сам DUE_CAP:
 * это последний слот, который ещё раньше первой попытки, и он всё равно в будущем.
 *
 * `rnd` вынесен в параметр, чтобы розыгрыш можно было проверить тестом, а не поверить в него.
 */
export function clampDueBeforeCap(next: FsrsCard, now: Date, cap: Date = DUE_CAP, rnd: () => number = Math.random): FsrsCard {
  if (next.state !== State.Review || now >= cap || next.due <= cap) return next
  const span = Math.min(14, Math.max(5, Math.round(next.stability / 10)))
  const earliest = Math.max(endOfStudyDay(now).getTime(), cap.getTime() - span * 86400_000)
  const slots = Math.max(0, Math.floor((cap.getTime() - earliest) / 86400_000))
  const due = new Date(cap.getTime() - Math.floor(rnd() * (slots + 1)) * 86400_000)
  // интервал считаем от фактически полученного срока: ноль здесь — честное «меньше суток»
  // (у метрик для него есть свой бакет), а замаскированная единица врала бы отчётности
  return { ...next, due, scheduled_days: Math.round((due.getTime() - now.getTime()) / 86400_000) }
}

/**
 * Замер времени, который уедет в журнал.
 *
 * Потолок cardTimeCap (journal.ts, «AFK-защита») применялся к зачётным минутам и к таймеру
 * на экране, но не к полю `elapsed_ms` самой строки — и в журнал попадали замеры вида «ответ
 * за 25 минут» (ученик отошёл, карточка осталась открытой): в живом журнале таких строк 28 из
 * 537. Это не медленный ответ, а отсутствие замера, и медиану времени ответа — от которой
 * считается порог «медленно» — они тянут на себя. Чиним на записи, а не на каждом чтении:
 * журнал уходит тьютору и в метрики как есть, и починку на чтении однажды забудут сделать.
 */
export function journalElapsedMs(elapsedMs: number, kind?: string): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0
  return Math.min(elapsedMs, cardTimeCap(kind))
}

/* Во сколько раз стабильность должна превысить порог пиявки, чтобы флаг сняли.
   Снимать по простому !isLeech нельзя: у порога стабильность гуляет, флаг дёргался бы
   туда-сюда на каждой оценке, а каждое движение — это dirty-карточка и лишний коммит в
   колоде. Тройной порог (6 дней против 2) — это уже не колебание, а несколько успешных
   повторов подряд: карточка вернулась в обычную ротацию, и «слово сопротивляется» на ней
   больше не про неё. */
const LEECH_CLEAR_FACTOR = 3

/**
 * Что сделать с флагом «Пиявка» после этой оценки: поставить, снять или ничего.
 *
 * Флаг ставился навсегда — снятия не было в кодовой базе нигде, и давно выученное слово
 * до самого экзамена показывало ученику «слово сопротивляется», а тьютору предлагало
 * переформулировать уже работающую карточку.
 */
export function leechTransition(leech: unknown, next: FsrsCard): 'set' | 'clear' | null {
  const flagged = !!leech
  if (!flagged) return isLeech(next) ? 'set' : null
  const recovered = next.state === State.Review && next.stability >= LEECH_STABILITY_DAYS * LEECH_CLEAR_FACTOR
  return recovered ? 'clear' : null
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
  // потолок интервалов: всё возвращается до DUE_CAP, окно 5–14 дней перед ним взвешено по
  // стабильности — прочные карточки раньше, хрупкие ближе к потолку (см. clampDueBeforeCap)
  next = clampDueBeforeCap(next, now)

  // point 1: слово, введённое сегодня, не уходит в Review внутри того же учебного
  // дня. Само правило и цена ошибки в нём — в holdOnIntroDay (scheduler.ts).
  const introDay = rec.fm.first_seen ?? (prev.state === State.New ? dayKey(now) : null)
  next = holdOnIntroDay(prev, next, now, introDay)

  // Упражнение (разбор, грамматика, математика) не возвращается в тот же учебный день:
  // повторный показ того же вопроса проверяет память об ответе, а не приём рассуждения.
  // Правило и цена ошибки в нём — в holdExerciseToNextDay (scheduler.ts).
  next = holdExerciseToNextDay(next, now, item.view.kind)

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
    elapsed_ms: journalElapsedMs(elapsedMs, item.view.kind),
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
     на шаг позже настоящего порога. Снятие флага — leechTransition, там же гистерезис. */
  const fm: Record<string, any> = { ...rec.fm, ...fmPatch }
  const leech = leechTransition(rec.fm.leech, next)
  if (leech === 'set') fm.leech = dayKey(now)
  // выздоровевшая карточка теряет поле целиком, а не получает пустую строку: `leech: ''`
  // в файле — тот же мусор, который тьютору пришлось бы читать и объяснять себе
  if (leech === 'clear') delete fm.leech
  const updated: CardRec = { ...rec, fm, dirty: 1 }
  // карточка и строка журнала — одной транзакцией: сбой между ними двигал бы расписание
  // без следа в журнале, а на журнале держится вся отчётность (см. db.putCardAndJournal)
  await db.putCardAndJournal(updated, [line])
  state.cards = state.cards.map(c => (c.path === rec.path ? updated : c))
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
export async function logReading(minutes: number, what = '', src = ''): Promise<void> {
  const min = Math.round(Math.min(Math.max(minutes, 1), READ_CAP_MINUTES))
  const now = new Date()
  const line: JournalRec = {
    id: newId(),
    v: 1, type: 'read', ts: isoLocal(now), ms: now.getMilliseconds(), day: dayKey(),
    read_min: min, what: what.trim().slice(0, 120), synced: 0,
    // `src` отличает измеренное чтение в приложении («reading:<слаг>») от введённого руками
    // кнопкой «+» на главной. Соглашение то же, что у отметок слов (`toggleWordMark`).
    ...(src ? { src } : {})
  }
  await db.putJournal([line])
  state.journal = [...state.journal, line]
  emit()
  updateBadge()
  void startSync()
}

/**
 * Слова колоды в нормализованной форме — основа признака `in_deck` у отметки.
 *
 * Берём и `word` из frontmatter, и слаг файла: слаг несёт разводящий суффикс (`bolster-2`),
 * который normWord срезает, а `word` бывает пустым у нестандартных карточек. Считается на
 * каждую отметку заново и намеренно не кэшируется: колода меняется синхронизацией, а тап по
 * слову — событие раз в несколько секунд, и устаревший кэш здесь дороже полутысячи строк.
 */
function deckWords(): Set<string> {
  const out = new Set<string>()
  for (const c of state.cards) {
    if (c.broken) continue
    const w = typeof c.fm?.word === 'string' ? normWord(c.fm.word) : ''
    if (w) out.add(w)
    const slug = normWord(slugFromPath(c.path))
    if (slug) out.add(slug)
  }
  return out
}

/**
 * Отметить незнакомое слово в тексте — или снять отметку, если она уже стоит.
 * Возвращает НОВОЕ состояние отметки (true = отмечено).
 *
 * Снятие пишется строкой `on: false`, а не удалением предыдущей строки, и это не стилистика.
 * Журнал append-only и сливается объединением по id: строка, удалённая на телефоне, вернулась
 * бы с ноутбука при первой же синхронизации, и отметка воскресла бы сама. Событие «снял» — это
 * такой же факт учебной работы, как «отметил»: тьютору видно, что слово сначала не узнали, а
 * потом узнали, и по паре строк восстанавливается порядок, которого удаление не оставило бы.
 * Текущее состояние собирается из потока строк (journal.activeMarks) — последнее решение по
 * каждой лемме, а не сумма событий.
 *
 * Синхронизацию отметка не запускает: за урок чтения их десятки, а уезжают они строкой
 * прочтения (logTextRead) и обычным циклом синка — как оценки внутри урока.
 *
 * Источник приходит готовой строкой (`readingSrc` для текста, `cardSrc` для условия карточки),
 * а не выводится из вида текста: незнакомое слово попадается и в упражнении, и отмечается там
 * тем же действием и той же строкой журнала. Знать о том, откуда пришло слово, здесь нечего —
 * это забота экрана, а разделять отметки по видам умеет сам префикс источника.
 */
export async function toggleWordMark(src: string, w: { word: string; lemma?: string; sentence?: string }): Promise<boolean> {
  const word = w.word.trim()
  const lemma = (w.lemma ?? '').trim() || normWord(word)
  if (!word || !lemma) return false // нечего отмечать: пустая или бессловесная выделенная строка
  const on = !isMarked(state.journal, src, word, lemma)
  const now = new Date()
  const line: JournalRec = {
    id: newId(),
    v: 1, type: 'mark', ts: isoLocal(now), ms: now.getMilliseconds(), day: dayKey(now),
    src, word, lemma,
    sentence: (w.sentence ?? '').trim().slice(0, MARK_SENTENCE_MAX),
    // историческая правда на момент отметки: карточку по этому слову могли завести и позже
    in_deck: deckHasWord(deckWords(), lemma, word),
    on, synced: 0
  }
  await db.putJournal([line])
  state.journal = [...state.journal, line]
  emit()
  return on
}

/**
 * Записать прочтение текста: слаг, сколько слов осталось отмечено и взят ли порог понятности.
 *
 * Число отметок берётся из журнала, а не из аргумента: единственный источник правды —
 * поток строк, и экран не должен иметь возможности разойтись с ним. Повторное чтение того же
 * текста пишет вторую строку — это второе событие, а не исправление первого; кто читал текст
 * хоть раз, видно по journal.readTextSlugs.
 *
 * Оценок FSRS чтение не пишет НИКОГДА — ни здесь, ни в toggleWordMark. Слово из глоссария
 * заводится карточкой руками тьютора (`_КОНТРАКТ.md`, «Слово из чтения попадает в колоду»),
 * и уровень ему назначает тоже тьютор: автоматики здесь нет и не будет.
 */
export async function logTextRead(text: ReadingView, seconds = 0): Promise<void> {
  const marks = markCount(state.journal, readingSrc(text.slug))
  const now = new Date()
  const line: JournalRec = {
    id: newId(),
    v: 1, type: 'reading', ts: isoLocal(now), ms: now.getMilliseconds(), day: dayKey(),
    slug: text.slug, marks, passed: readingPassed(marks, text.words), synced: 0,
    /* Секунды над текстом — единственное место, где вообще есть темп чтения: слов в
       тексте известно, времени до сих пор не знал никто. Правило повышения ступени
       чтения не откалибровано именно потому, что калибровать было не на чем. Поле
       добавлено, а не подменено (D3): старые строки без него читаются как прежде. */
    ...(seconds > 0 ? { read_s: Math.round(seconds) } : {})
  }
  await db.putJournal([line])
  state.journal = [...state.journal, line]
  emit()
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
    const budget = newBudgetTotal(все, NEW_PER_DAY.norm, state.journal, dayKey())
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
