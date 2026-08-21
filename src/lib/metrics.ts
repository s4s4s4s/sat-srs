import { fsrs, generatorParameters, State, type FSRS } from 'ts-fsrs'
import type { CardView, JournalLine } from './types'
import { isLevelled, PRIMARY_DATE, NEW_STOP_DATE } from './scheduler'
import { addDaysKey, dayKey } from './daytime'
import { byTime, minutesByDay, readMinutesByDay } from './journal'

/**
 * Чистые метрики прогресса над (cards, journal, now) — без побочных эффектов.
 *
 * Главных чисел два: сколько карточек доведено до состояния Review (TARGET_REVIEW)
 * и сколько из них зрелых (TARGET_MATURE, стабильность >= MATURE_STABILITY_DAYS).
 * Вспомогательное — «готово к экзамену» по прогнозной retrievability: карточка
 * готова, если её retrievability на целевую дату >= 0.90 при текущей stability,
 * БЕЗ будущих повторов. Считаем через ts-fsrs (get_retrievability), а не своей
 * формулой, — метрика обязана быть согласована с планировщиком.
 *
 * Целевые даты живут в scheduler.ts и переэкспортируются отсюда для тех,
 * кто и так берёт метрики. Держать две копии `PRIMARY_DATE` в разных файлах
 * уже пробовали: метрика считала по 03.10, планировщик по 07.11, и колода
 * готовилась на месяц позже, чем нужно.
 */

/* Три даты — одно место жительства, scheduler.ts. Метрика их только
   переэкспортирует: копия `PRIMARY_DATE` в двух файлах уже стоила месяца
   подготовки (метрика считала по 03.10, планировщик по 07.11).
   `NEW_STOP_DATE` — граница включительно: с 00:00 19.09.2026 бюджет новых
   нулевой, последний день ввода — 18.09. Планировщик гасит ввод именно так
   (`newIntroAllowed`), и темп обязан считать по той же границе, иначе экран
   будет требовать «+7 слов в день» в день, когда урок новых уже не выдаёт. */
export { PRIMARY_DATE, EXAM_DATE, NEW_STOP_DATE } from './scheduler'

/* Пиявка — одно определение на всё приложение.

   Определений было два, несовместимых. Отчёт считал пиявкой много повторов при
   неподросшей стабильности и находил 14 слов; приложение ставило пометку
   `leech` в карточку при `lapses >= leech_lapses + 6` — а lapses растёт только
   при провале из Review, и максимум по всей колоде был 2. Поэтому плашка
   «Пиявка — переформулировать» не показалась НИ РАЗУ, тьютор сигнала не
   получал, и 14 слов съели 210 показов из 486 — 43% всей работы системы.
   Повторение интерференцию не лечит: такое слово надо переформулировать
   (новый контекст, другая мнемоника, confusables), а не показывать ещё раз. */
export const LEECH_REPS = 8
export const LEECH_STABILITY_DAYS = 2

export function isLeech(f: { reps: number; stability: number } | null | undefined): boolean {
  return !!f && f.reps >= LEECH_REPS && f.stability < LEECH_STABILITY_DAYS
}

/** Карточка-пиявка: пиявкой оказалось само слово или его prep-навык.
 *  Одно определение на отчёт, снимок метрик и экран — списки и счётчик обязаны сходиться. */
export function isLeechCard(v: CardView): boolean {
  return isLeech(v.fsrs) || isLeech(v.fsrsPrep)
}
/* Цель. 17.08.2026 прежняя — «400 готовых слов к 03.10» — отменена как
   арифметически недостижимая. Готовность считалась по прогнозной
   retrievability, слово созревает примерно за 21 день стабильности, значит всё
   введённое после ~12.09 к первой попытке не успевает, а в колоде на тот момент
   было 450 карточек и 38 в Review. Цифра, которую нельзя выполнить, не
   мотивирует, а деморализует: экран до самого экзамена показывал бы «отстаёшь
   на N дней» от снятой цели.

   Новая цель — две величины, обе достижимые вводом и повторением: довести
   250–300 карточек до состояния Review (ориентир TARGET_REVIEW = 275) и из них
   TARGET_MATURE = 150 сделать зрелыми (стабильность >= MATURE_STABILITY_DAYS
   на целевую дату). Первая набирается вводом до NEW_STOP_DATE, вторая — только
   повторением, и потому вводом её не подгонишь. */
export const TARGET_REVIEW = 275                   // карточек доведено до Review (коридор 250–300)
export const TARGET_MATURE = 150                   // из них зрелых на целевую дату
export const READY_R = 0.90                        // порог готовности
export const MATURE_STABILITY_DAYS = 21            // «зрелое» слово — человеческая версия готовности
export const SLOW_MS = 10_000                      // ответ дольше 10 c — «знаю, но думаю»

/* Процент по горстке показов — не измерение, а шум с видом измерения.
   17.08.2026 таблица ретеншна показала «50% на 4–10 днях» по ЧЕТЫРЁМ показам,
   и это подняло тревогу на пустом месте: доверительный интервал такой оценки
   покрывает почти всю шкалу. Ниже этого n процент не показываем вовсе —
   показываем «мало данных» и само n. */
export const MIN_N_FOR_PCT = 20

export function enoughForPct(n: number): boolean {
  return n >= MIN_N_FOR_PCT
}

/** Дата в человеческом «дд.мм» — подписи целей на экране и в отчёте берут её отсюда,
 *  чтобы месяц в тексте не разъезжался с константой при переносе даты. */
export function ddmm(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`
}

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

export interface Maturity { medianStability: number; p25: number; p75: number; matureCount: number; reviewCount: number; n: number }

/** Числитель первой цели: сколько словарных карточек доведено до состояния Review. */
export function reviewCount(cards: CardView[]): number {
  return cards.filter(v => isCandidate(v) && v.fsrs.state === State.Review).length
}

/**
 * Зрелость колоды: медианная стабильность, число «зрелых» слов (stability >= 21 дн)
 * и число доведённых до Review — числители обеих целей.
 * `n` — все не-New кандидаты (Review + Learning/Relearning), поэтому n >= reviewCount.
 */
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
    reviewCount: reviewCount(cards),
    n: stabs.length
  }
}

export interface Pace {
  inReview: number            // уже доведено до Review
  remaining: number           // сколько ещё довести до TARGET_REVIEW
  daysLeft: number            // дней до стопа ввода новых (0 = стоп уже прошёл)
  neededPerDay: number
  actual7: number
  actual14: number
  daysBehind: number | null   // null = темпа нет (0 слов за 14 дн), а дефицит есть; либо ввод закрыт
  verdict: 'ahead' | 'behind' | 'closed'
}

/**
 * Темп ввода к стопу новых слов (`stopDate`, по умолчанию NEW_STOP_DATE).
 *
 * Вопрос, на который отвечает функция, сменился 17.08.2026 вместе с целью: было
 * «сколько из 400 готово к 03.10», стало «успеваю ли довести TARGET_REVIEW карточек
 * до Review, пока ввод новых ещё открыт». После стопа темп ввода смысла не имеет —
 * остаётся дозревание, и функция честно говорит `closed`, а не считает дефицит,
 * который уже нечем закрыть.
 *
 * «Довели до Review» восстанавливаем из журнала как graduation (prev_state != Review,
 * new_state == Review) — это единственный сигнал темпа, выводимый из сырого журнала;
 * точный ряд копится в `_метрики.ndjson`.
 */
export function pace(cards: CardView[], journal: JournalLine[], stopDate: Date = NEW_STOP_DATE, now: Date = new Date()): Pace {
  const inReview = reviewCount(cards)
  const remaining = Math.max(0, TARGET_REVIEW - inReview)
  // Граница включительно, как в планировщике (`newIntroAllowed`): в сам день стопа
  // бюджет новых уже нулевой. Считать на день дольше — значит требовать ввода в день,
  // когда урок новых физически не выдаст.
  const daysLeft = Math.max(0, Math.ceil((stopDate.getTime() - now.getTime()) / 86400_000))
  const today = dayKey(now)
  const actual7 = graduatedInWindow(journal, addDaysKey(today, -6), today)
  const actual14 = graduatedInWindow(journal, addDaysKey(today, -13), today)
  if (daysLeft === 0) {
    return { inReview, remaining, daysLeft, neededPerDay: 0, actual7, actual14, daysBehind: null, verdict: 'closed' }
  }
  const neededPerDay = Math.round((remaining / daysLeft) * 10) / 10
  const rate = actual14 / 14
  const shortfall = TARGET_REVIEW - (inReview + rate * daysLeft)
  const verdict: Pace['verdict'] = shortfall <= 0 ? 'ahead' : 'behind'
  const daysBehind = shortfall <= 0
    ? Math.round(shortfall / (rate || 1))               // <= 0: опережение
    : (rate > 0 ? Math.ceil(shortfall / rate) : null)   // темпа нет — дней не посчитать
  return { inReview, remaining, daysLeft, neededPerDay, actual7, actual14, daysBehind, verdict }
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
  return l.type === 'review' && l.prev_state === State.Review && !l.typo && !l.twin
}

export type IntervalBucket = '<1' | '1-3' | '4-10' | '11-30' | '30+'

/* Бакет «меньше суток» заведён 17.08.2026 отдельно, и это не косметика.
   Внутридневные повторы (learning-шаги, переспрос после опечатки) попадали в
   «1–3 дн»: из 70 показов того бакета 49 были внутридневными. То есть бакет
   мерил смесь двух разных вещей — узнавания через пару минут и настоящего
   межднёвного удержания — и его процент нельзя было толковать никак. */
export function intervalBucketOf(days: number): IntervalBucket {
  if (days < 1) return '<1'
  if (days <= 3) return '1-3'
  if (days <= 10) return '4-10'
  if (days <= 30) return '11-30'
  return '30+'
}

/** Человеческие подписи бакетов — одни на экран и отчёт, чтобы «<1» нигде не вылезло как есть. */
export const INTERVAL_LABELS: Record<IntervalBucket, string> = {
  '<1': 'меньше суток', '1-3': '1–3 дн', '4-10': '4–10 дн', '11-30': '11–30 дн', '30+': '30+ дн'
}

/**
 * Retention по бакетам интервала — самая ценная таблица: общий retention смешивает интервалы
 * в полтора дня и в три недели. Интервал берём из scheduled_days (пишется с шага 2), иначе
 * реконструируем как разницу ts соседних показов одного slug#skill.
 */
export function retentionByInterval(journal: JournalLine[]): Record<IntervalBucket, Bucketed> {
  const out: Record<IntervalBucket, Bucketed> = {
    '<1': emptyBucket(), '1-3': emptyBucket(), '4-10': emptyBucket(), '11-30': emptyBucket(), '30+': emptyBucket()
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
  /* Отдельно по видам карточек: словарное узнавание и разбор условия с таблицей
     — разные работы, и мерить их одной медианой нельзя (см. slowThresholdMs). */
  byKind: Record<string, { medianMs: number; n: number }>
}

/** Скорость ответа: медиана, p90 и доля «медленных» (> 10 c). На SAT узнавание должно быть за 2–3 c. */
export function speedStats(journal: JournalLine[]): SpeedStats {
  const rev = journal.filter(l =>
    l.type === 'review' && typeof l.elapsed_ms === 'number' && l.elapsed_ms > 0 && l.format && l.format !== 'intro')
  const all = rev.map(l => l.elapsed_ms as number).sort((a, b) => a - b)
  const byFmt = new Map<string, number[]>()
  const byKnd = new Map<string, number[]>()
  for (const l of rev) {
    const a = byFmt.get(l.format!) ?? []
    a.push(l.elapsed_ms as number)
    byFmt.set(l.format!, a)
    // kind в строку пишется, только когда он не vocab (store.ts), — отсутствие
    // поля здесь значит «словарная», а не «неизвестно».
    const k = l.kind ?? 'vocab'
    const b = byKnd.get(k) ?? []
    b.push(l.elapsed_ms as number)
    byKnd.set(k, b)
  }
  const share = (arr: number[]) => (arr.length ? Math.round((arr.filter(m => m > SLOW_MS).length / arr.length) * 100) / 100 : 0)
  const byFormat: SpeedStats['byFormat'] = {}
  for (const [f, arr] of byFmt) {
    const s = [...arr].sort((a, b) => a - b)
    byFormat[f] = { medianMs: Math.round(percentile(s, 0.5)), slowShare: share(arr), n: arr.length }
  }
  const byKind: SpeedStats['byKind'] = {}
  for (const [k, arr] of byKnd) {
    byKind[k] = { medianMs: Math.round(percentile([...arr].sort((a, b) => a - b), 0.5)), n: arr.length }
  }
  return {
    medianMs: Math.round(percentile(all, 0.5)),
    p90Ms: Math.round(percentile(all, 0.9)),
    slowShare: share(all),
    n: all.length,
    byFormat,
    byKind
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

export interface GaveUp { share: number; gaveUp: number; n: number }

/**
 * Доля «не помню» — показы, где человек сам признал незнание (`gave_up`, кнопка «Не помню»
 * или пустой ввод), а не ошибся написанием. Это единственный сигнал, отделяющий «не знаю»
 * от «знаю, но промахнулся», и до 17.08.2026 он не попадал никуда, кроме сырого журнала.
 * Знакомство (`intro`) вне знаменателя: там нечего вспоминать.
 * `day` задан — считаем за этот учебный день (атом дневного снимка), иначе за всю историю.
 */
export function gaveUpShare(journal: JournalLine[], day?: string): GaveUp {
  const rev = journal.filter(l => l.type === 'review' && l.format !== 'intro' && (day === undefined || l.day === day))
  const g = rev.filter(l => l.gave_up === true).length
  return { share: rev.length ? Math.round((g / rev.length) * 100) / 100 : 0, gaveUp: g, n: rev.length }
}

// ---- снимок истории ------------------------------------------------------

export interface MetricSnapshot {
  day: string
  ready: number
  readyTotal: number
  readyExam: number          // готовность к EXAM_DATE (07.11) — вторая дата
  inReview: number           // числитель первой цели (TARGET_REVIEW)
  neededPerDay: number
  actual7: number
  actual14: number
  daysBehind: number | null
  verdict: string
  medianStability: number
  matureCount: number
  minutes: number
  /* Три поля ниже добавлены 17.08.2026: без них ряд снимков не мог ответить,
     стало ли лучше. Чтение — вторая половина защищённого минимума, семь недель
     показывавшая ноль; пиявки — 43% работы системы, съеденные полутора десятками
     слов; «не помню» — единственный признак настоящего незнания. Схема ndjson
     расширяется добавлением полей: старые строки читаются без них. */
  readMinutes: number        // минут чтения за день (type:'read', read_min)
  leeches: number            // карточек под isLeechCard
  gaveUpShare: number        // доля показов дня с gave_up (0..1)
  gaveUpN: number            // знаменатель этой доли — без него share нечем взвесить
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
  const pc = pace(cards, journal, NEW_STOP_DATE, now)
  const mat = maturity(cards)
  const sp = speedStats(journal)
  const ts = typoSplit(journal)
  const gu = gaveUpShare(journal, today)
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
    inReview: pc.inReview,
    neededPerDay: pc.neededPerDay,
    actual7: pc.actual7,
    actual14: pc.actual14,
    daysBehind: pc.daysBehind,
    verdict: pc.verdict,
    medianStability: mat.medianStability,
    matureCount: mat.matureCount,
    minutes: Math.round(minutesByDay(journal).get(today) ?? 0),
    readMinutes: Math.round(readMinutesByDay(journal).get(today) ?? 0),
    leeches: cards.filter(v => !v.suspended && isLeechCard(v)).length,
    gaveUpShare: gu.share,
    gaveUpN: gu.n,
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
