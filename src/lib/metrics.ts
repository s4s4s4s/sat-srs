import { fsrs, generatorParameters, State, type FSRS } from 'ts-fsrs'
import type { CardView, JournalLine } from './types'
import { isLevelled } from './scheduler'
import { addDaysKey, dayKey } from './daytime'
import { byTime, minutesByDay } from './journal'

/**
 * Чистые метрики прогресса над (cards, journal, now) — без побочных эффектов.
 * Главное число — «слов готово к экзамену»: карточка готова, если её прогнозируемая
 * retrievability на целевую дату >= 0.90 при текущей stability, БЕЗ будущих повторов.
 * Считаем через ts-fsrs (get_retrievability), а не своей формулой, — метрика обязана быть
 * согласована с планировщиком.
 *
 * Две целевые даты: PRIMARY_DATE (03.10 — реальный якорь, регистрация до 18.09) и
 * EXAM_DATE (07.11, в scheduler.ts — на ней завязаны DUE_CAP/effectiveRetention, её не трогаем).
 */

export const PRIMARY_DATE = new Date(2026, 9, 3)   // 03.10.2026, локально
export const TARGET_WORDS = 400                    // цель: вся колода
export const READY_R = 0.90                        // порог готовности
export const MATURE_STABILITY_DAYS = 21            // «зрелое» слово — человеческая версия готовности
export const SLOW_MS = 10_000                      // ответ дольше 10 c — «знаю, но думаю»

let _f: FSRS | null = null
/**
 * Кривая забывания FSRS-6 задаётся параметрами (w, decay) и НЕ зависит от request_retention:
 * последний влияет только на интервалы планировщика, не на get_retrievability. Поэтому берём
 * дефолтные параметры — retrievability остаётся согласованной с планировщиком.
 */
function scheduler(): FSRS {
  if (!_f) _f = fsrs(generatorParameters({ enable_fuzz: false }))
  return _f
}

/** Словарная карточка, которую учитываем в готовности: vocab, не связка, не приостановлена. */
function isCandidate(v: CardView): boolean {
  return isLevelled(v) && !v.suspended
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  if (sorted.length === 1) return sorted[0]
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

// ---- главное число -------------------------------------------------------

export interface ReadyByLevel { level: number; ready: number; total: number }
export interface ExamReady { ready: number; total: number; byLevel: ReadyByLevel[] }

/**
 * «Слов готово к экзамену» на дату `date`. Готово = не New И retrievability(date) >= 0.90.
 * total — число словарных карточек в колоде; byLevel — разбивка готовности по ступеням.
 */
export function examReady(cards: CardView[], date: Date = PRIMARY_DATE): ExamReady {
  const f = scheduler()
  const cand = cards.filter(isCandidate)
  const byLevel = new Map<number, { ready: number; total: number }>()
  let ready = 0
  for (const v of cand) {
    const e = byLevel.get(v.level) ?? { ready: 0, total: 0 }
    e.total++
    const isReady = v.fsrs.state !== State.New && (f.get_retrievability(v.fsrs, date, false) as number) >= READY_R
    if (isReady) { ready++; e.ready++ }
    byLevel.set(v.level, e)
  }
  return {
    ready,
    total: cand.length,
    byLevel: [...byLevel.entries()].map(([level, e]) => ({ level, ...e })).sort((a, b) => a.level - b.level)
  }
}

export interface Maturity { medianStability: number; p25: number; p75: number; matureCount: number; n: number }

/** Зрелость колоды: медианная стабильность и число «зрелых» слов (stability >= 21 дн). */
export function maturity(cards: CardView[]): Maturity {
  const stabs = cards
    .filter(v => isCandidate(v) && v.fsrs.state !== State.New)
    .map(v => v.fsrs.stability)
    .sort((a, b) => a - b)
  return {
    medianStability: Math.round(percentile(stabs, 0.5) * 10) / 10,
    p25: Math.round(percentile(stabs, 0.25) * 10) / 10,
    p75: Math.round(percentile(stabs, 0.75) * 10) / 10,
    matureCount: stabs.filter(s => s >= MATURE_STABILITY_DAYS).length,
    n: stabs.length
  }
}

export interface Pace {
  neededPerDay: number
  actual7: number
  actual14: number
  daysBehind: number | null   // null = темпа нет (0 слов за 14 дн), а дефицит есть
  verdict: 'ahead' | 'behind'
  ready: number
  remaining: number
  daysLeft: number
}

/**
 * Дефицит и темп к дате `date`. «Стало готово» восстанавливаем из журнала как graduation
 * в Review (prev_state != Review, new_state == Review) — это единственный сигнал темпа,
 * выводимый из сырого журнала; точный ряд готовности копится в `_метрики.ndjson` (см. шаг 2).
 */
export function pace(cards: CardView[], journal: JournalLine[], date: Date = PRIMARY_DATE, now: Date = new Date()): Pace {
  const { ready } = examReady(cards, date)
  const remaining = Math.max(0, TARGET_WORDS - ready)
  const daysLeft = Math.max(1, Math.ceil((date.getTime() - now.getTime()) / 86400_000))
  const neededPerDay = Math.round((remaining / daysLeft) * 10) / 10
  const today = dayKey(now)
  const actual7 = graduatedInWindow(journal, addDaysKey(today, -6), today)
  const actual14 = graduatedInWindow(journal, addDaysKey(today, -13), today)
  const rate = actual14 / 14
  const shortfall = TARGET_WORDS - (ready + rate * daysLeft)
  const verdict: Pace['verdict'] = shortfall <= 0 ? 'ahead' : 'behind'
  const daysBehind = shortfall <= 0
    ? Math.round(shortfall / (rate || 1))               // <= 0: опережение
    : (rate > 0 ? Math.ceil(shortfall / rate) : null)   // темпа нет — дней не посчитать
  return { neededPerDay, actual7, actual14, daysBehind, verdict, ready, remaining, daysLeft }
}

/** Слова, вышедшие в Review (graduation) в окне [from, to] — прокси темпа по журналу. */
function graduatedInWindow(journal: JournalLine[], from: string, to: string): number {
  const s = new Set<string>()
  for (const l of journal) {
    if (l.type !== 'review' || !l.slug || !l.day || l.day < from || l.day > to) continue
    if (l.new_state === State.Review && l.prev_state !== State.Review) s.add(l.slug)
  }
  return s.size
}

// ---- ретеншн по разрезам -------------------------------------------------

export interface Bucketed { pct: number | null; n: number; pass: number }
const emptyBucket = (): Bucketed => ({ pct: null, n: 0, pass: 0 })
const seal = (b: Bucketed): Bucketed => ({ ...b, pct: b.n ? Math.round((b.pass / b.n) * 100) : null })

/** Зрелый показ, засчитываемый в retention: review-строка, prev_state=Review, не опечатка. */
function isMatureShow(l: JournalLine): boolean {
  return l.type === 'review' && l.prev_state === State.Review && !l.typo
}

export type IntervalBucket = '1-3' | '4-10' | '11-30' | '30+'

function intervalBucketOf(days: number): IntervalBucket {
  if (days <= 3) return '1-3'
  if (days <= 10) return '4-10'
  if (days <= 30) return '11-30'
  return '30+'
}

/**
 * Retention по бакетам интервала — самая ценная таблица: общий retention смешивает интервалы
 * в полтора дня и в три недели. Интервал берём из scheduled_days (пишется с шага 2), иначе
 * реконструируем как разницу ts соседних показов одного slug#skill.
 */
export function retentionByInterval(journal: JournalLine[]): Record<IntervalBucket, Bucketed> {
  const out: Record<IntervalBucket, Bucketed> = {
    '1-3': emptyBucket(), '4-10': emptyBucket(), '11-30': emptyBucket(), '30+': emptyBucket()
  }
  const prevTs = new Map<string, number>()
  const lines = journal.filter(l => l.type === 'review' && l.slug).sort(byTime)
  for (const l of lines) {
    const key = `${l.slug}#${l.skill ?? 'recall'}`
    const t = Date.parse(l.ts)
    const prev = prevTs.get(key)
    let interval: number | null = null
    if (typeof l.scheduled_days === 'number' && l.scheduled_days > 0) interval = l.scheduled_days
    else if (prev !== undefined && Number.isFinite(t)) interval = (t - prev) / 86400_000
    if (Number.isFinite(t)) prevTs.set(key, t)
    if (!isMatureShow(l) || interval === null) continue
    const cell = out[intervalBucketOf(interval)]
    cell.n++
    if ((l.rating ?? 0) > 1) cell.pass++
  }
  for (const k of Object.keys(out) as IntervalBucket[]) out[k] = seal(out[k])
  return out
}

function bucketByKey<K>(journal: JournalLine[], keyOf: (l: JournalLine) => K | undefined): Map<K, Bucketed> {
  const m = new Map<K, Bucketed>()
  for (const l of journal) {
    if (!isMatureShow(l) || !l.slug) continue
    const k = keyOf(l)
    if (k === undefined) continue
    const cell = m.get(k) ?? emptyBucket()
    cell.n++
    if ((l.rating ?? 0) > 1) cell.pass++
    m.set(k, cell)
  }
  for (const [k, v] of m) m.set(k, seal(v))
  return m
}

/**
 * Retention по ступеням L1…L6. Ступень берём из строки журнала (`level`, пишется с шага 2),
 * а для старых строк — join по текущему frontmatter карточки (после переразметки может врать —
 * поэтому поле в журнал и добавлено).
 */
export function retentionByLevel(cards: CardView[], journal: JournalLine[]): Map<number, Bucketed> {
  const levelBySlug = new Map<string, number>()
  for (const v of cards) if (isLevelled(v)) levelBySlug.set(v.slug, v.level)
  return bucketByKey(journal, l => {
    const lv = typeof l.level === 'number' ? l.level : levelBySlug.get(l.slug!)
    return lv === undefined || lv >= 999 ? undefined : lv
  })
}

/** Retention по домену College Board (II/CS/EOI/SEC/…). */
export function retentionByDomain(journal: JournalLine[]): Map<string, Bucketed> {
  return bucketByKey(journal, l => (l.domain ? l.domain : undefined))
}

export interface SpeedStats {
  medianMs: number
  p90Ms: number
  slowShare: number
  n: number
  byFormat: Record<string, { medianMs: number; slowShare: number; n: number }>
}

/** Скорость ответа: медиана, p90 и доля «медленных» (> 10 c). На SAT узнавание должно быть за 2–3 c. */
export function speedStats(journal: JournalLine[]): SpeedStats {
  const rev = journal.filter(l =>
    l.type === 'review' && typeof l.elapsed_ms === 'number' && l.elapsed_ms > 0 && l.format && l.format !== 'intro')
  const all = rev.map(l => l.elapsed_ms as number).sort((a, b) => a - b)
  const byFmt = new Map<string, number[]>()
  for (const l of rev) {
    const a = byFmt.get(l.format!) ?? []
    a.push(l.elapsed_ms as number)
    byFmt.set(l.format!, a)
  }
  const share = (arr: number[]) => (arr.length ? Math.round((arr.filter(m => m > SLOW_MS).length / arr.length) * 100) / 100 : 0)
  const byFormat: SpeedStats['byFormat'] = {}
  for (const [f, arr] of byFmt) {
    const s = [...arr].sort((a, b) => a - b)
    byFormat[f] = { medianMs: Math.round(percentile(s, 0.5)), slowShare: share(arr), n: arr.length }
  }
  return {
    medianMs: Math.round(percentile(all, 0.5)),
    p90Ms: Math.round(percentile(all, 0.9)),
    slowShare: share(all),
    n: all.length,
    byFormat
  }
}

/**
 * Опечатки vs незнание среди показов формата `type`. Опечатка помечается в момент ввода
 * (см. Review.tsx / checkTyped) полем `typo` — задним числом её не восстановить (введённая
 * строка в журнал не пишется), поэтому старые строки идут в realMisses по `correct === false`.
 */
export function typoSplit(journal: JournalLine[]): { typos: number; realMisses: number } {
  let typos = 0
  let realMisses = 0
  for (const l of journal) {
    if (l.type !== 'review' || l.format !== 'type') continue
    if (l.typo) typos++
    else if (l.correct === false) realMisses++
  }
  return { typos, realMisses }
}

// ---- снимок истории ------------------------------------------------------

export interface MetricSnapshot {
  day: string
  ready: number
  readyTotal: number
  readyExam: number          // готовность к EXAM_DATE (07.11) — вторая дата
  neededPerDay: number
  actual7: number
  actual14: number
  daysBehind: number | null
  verdict: string
  medianStability: number
  matureCount: number
  minutes: number
  byInterval: Record<string, { pct: number | null; n: number }>
  byLevel: Record<string, { pct: number | null; n: number }>
  byDomain: Record<string, { pct: number | null; n: number }>
  speedMedianMs: number
  slowShare: number
  typos: number
  realMisses: number
}

const bucketOut = (b: Bucketed) => ({ pct: b.pct, n: b.n })

/** Снимок всех агрегатов слоёв 1–3 на момент now — одна строка `_метрики.ndjson`. */
export function buildMetricsSnapshot(cards: CardView[], journal: JournalLine[], now: Date = new Date(), examDate?: Date): MetricSnapshot {
  const today = dayKey(now)
  const er = examReady(cards, PRIMARY_DATE)
  const erExam = examDate ? examReady(cards, examDate) : er
  const pc = pace(cards, journal, PRIMARY_DATE, now)
  const mat = maturity(cards)
  const sp = speedStats(journal)
  const ts = typoSplit(journal)
  const byInterval: Record<string, { pct: number | null; n: number }> = {}
  for (const [k, v] of Object.entries(retentionByInterval(journal))) byInterval[k] = bucketOut(v)
  const byLevel: Record<string, { pct: number | null; n: number }> = {}
  for (const [k, v] of retentionByLevel(cards, journal)) byLevel[String(k)] = bucketOut(v)
  const byDomain: Record<string, { pct: number | null; n: number }> = {}
  for (const [k, v] of retentionByDomain(journal)) byDomain[k] = bucketOut(v)
  return {
    day: today,
    ready: er.ready,
    readyTotal: er.total,
    readyExam: erExam.ready,
    neededPerDay: pc.neededPerDay,
    actual7: pc.actual7,
    actual14: pc.actual14,
    daysBehind: pc.daysBehind,
    verdict: pc.verdict,
    medianStability: mat.medianStability,
    matureCount: mat.matureCount,
    minutes: Math.round(minutesByDay(journal).get(today) ?? 0),
    byInterval,
    byLevel,
    byDomain,
    speedMedianMs: sp.medianMs,
    slowShare: sp.slowShare,
    typos: ts.typos,
    realMisses: ts.realMisses
  }
}

/** Дописать снимок дня, если строки за этот день ещё нет (одна строка в день). */
export function appendDailySnapshot(existing: string, snap: MetricSnapshot): { text: string; appended: boolean } {
  const lines = (existing || '').split('\n').map(s => s.trim()).filter(Boolean)
  for (const ln of lines) {
    try {
      const o = JSON.parse(ln)
      if (o && o.day === snap.day) return { text: existing, appended: false }
    } catch { /* битую строку сохраняем как есть */ }
  }
  const body = [...lines, JSON.stringify(snap)]
  return { text: body.join('\n') + '\n', appended: true }
}

/** Разбор `_метрики.ndjson` в отсортированный по дню ряд снимков. */
export function parseMetrics(text: string): MetricSnapshot[] {
  const out: MetricSnapshot[] = []
  for (const raw of (text || '').split('\n')) {
    const s = raw.trim()
    if (!s) continue
    try {
      const o = JSON.parse(s)
      if (o && typeof o.day === 'string') out.push(o as MetricSnapshot)
    } catch { /* пропускаем битую строку */ }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day))
}
