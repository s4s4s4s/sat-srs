/**
 * Тесты чистых функций метрик (src/lib/metrics.ts) — без React/IndexedDB. Гоняют РЕАЛЬНЫЕ
 * функции: examReady (через ts-fsrs get_retrievability), maturity, pace, retentionByInterval,
 * retentionByLevel/Domain, speedStats, typoSplit, appendDailySnapshot/parseMetrics.
 *
 * Запуск: `npm run test:metrics` (esbuild бандлит файл и node его исполняет).
 */
import { fsrs, generatorParameters, State, type Card as FsrsCard } from 'ts-fsrs'
import type { CardView, JournalLine } from '../src/lib/types'
import {
  examReady, maturity, pace, retentionByInterval, retentionByLevel, retentionByDomain,
  speedStats, typoSplit, appendDailySnapshot, parseMetrics, buildMetricsSnapshot,
  PRIMARY_DATE, TARGET_WORDS, READY_R
} from '../src/lib/metrics'
import { dayKey, addDaysKey } from '../src/lib/daytime'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

// ---- фабрики -------------------------------------------------------------

function vocab(slug: string, f: FsrsCard, level = 1, extra: Partial<CardView> = {}): CardView {
  return {
    path: `deck/${slug}.md`, slug, word: slug, pos: 'adj', context: '', contexts: [],
    meaning_en: '', meaning_ru: 'значение', roots: '', source: 'test', added: '2026-07-01',
    level, kind: 'vocab', domain: '', confusables: [], leech: '', choices: [], answerText: '',
    answerNum: '', desmos: false, explain: '', suspended: false, fsrs: f,
    prep: '', prepContext: '', fsrsPrep: null, ...extra
  }
}

/** Review-карточка со стабильностью и датой последнего повтора за N дней до PRIMARY_DATE. */
function reviewFsrs(stability: number, lastReviewDaysBeforePrimary: number): FsrsCard {
  return {
    due: new Date(PRIMARY_DATE),
    stability,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 5,
    lapses: 0,
    state: State.Review,
    last_review: new Date(PRIMARY_DATE.getTime() - lastReviewDaysBeforePrimary * 86400_000)
  }
}

function newFsrs(): FsrsCard {
  return {
    due: new Date(PRIMARY_DATE), stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0,
    learning_steps: 0, reps: 0, lapses: 0, state: State.New, last_review: undefined
  }
}

const rev = (o: Partial<JournalLine>): JournalLine => ({
  id: Math.random().toString(36).slice(2), type: 'review', ts: '2026-09-01T10:00:00+03:00',
  day: '2026-09-01', ...o
})

// ---- examReady -----------------------------------------------------------

function examReadyChecks(): void {
  const f = fsrs(generatorParameters({ enable_fuzz: false }))
  const readyCard = vocab('ready', reviewFsrs(300, 4), 1)     // высокая стаб., недавно — R высок
  const staleCard = vocab('stale', reviewFsrs(1, 60), 1)      // низкая стаб., давно — R мал
  const freshCard = vocab('fresh', newFsrs(), 2)              // New — заведомо не готово

  // сверка с ts-fsrs напрямую (метрика обязана совпадать с планировщиком)
  const rReady = f.get_retrievability(readyCard.fsrs, PRIMARY_DATE, false) as number
  const rStale = f.get_retrievability(staleCard.fsrs, PRIMARY_DATE, false) as number
  assert(rReady >= READY_R, `setup: readyCard R=${rReady} должно быть >= ${READY_R}`)
  assert(rStale < READY_R, `setup: staleCard R=${rStale} должно быть < ${READY_R}`)

  const er = examReady([readyCard, staleCard, freshCard], PRIMARY_DATE)
  assert(er.ready === 1, `examReady.ready ожидалось 1, получено ${er.ready}`)
  assert(er.total === 3, `examReady.total ожидалось 3, получено ${er.total}`)

  // byLevel: суммы совпадают с общими, разложение по ступеням верно
  const totalByLevel = er.byLevel.reduce((a, l) => a + l.total, 0)
  const readyByLevel = er.byLevel.reduce((a, l) => a + l.ready, 0)
  assert(totalByLevel === er.total && readyByLevel === er.ready, 'byLevel суммы должны совпадать с общими')
  const l1 = er.byLevel.find(l => l.level === 1)!
  assert(l1.total === 2 && l1.ready === 1, `L1 ожидалось total=2 ready=1, получено total=${l1.total} ready=${l1.ready}`)

  // suspended и не-vocab исключаются
  const suspended = vocab('susp', reviewFsrs(300, 4), 1, { suspended: true })
  const transition = vocab('trans', reviewFsrs(300, 4), 1, { pos: 'transition' })
  const math = vocab('m1', reviewFsrs(300, 4), 1, { kind: 'math' })
  const er2 = examReady([readyCard, suspended, transition, math], PRIMARY_DATE)
  assert(er2.total === 1 && er2.ready === 1, `фильтр кандидатов: ожидалось total=1 ready=1, получено total=${er2.total} ready=${er2.ready}`)

  group('examReady: R>=0.90 совпадает с ts-fsrs, New/suspended/не-vocab исключены, byLevel сходится')
}

// ---- maturity ------------------------------------------------------------

function maturityChecks(): void {
  const deck = [
    vocab('a', reviewFsrs(25, 1)), vocab('b', reviewFsrs(30, 1)), vocab('c', reviewFsrs(10, 1)),
    vocab('d', newFsrs())  // New не учитывается
  ]
  const m = maturity(deck)
  assert(m.n === 3, `maturity.n ожидалось 3, получено ${m.n}`)
  assert(m.matureCount === 2, `mature (stab>=21) ожидалось 2, получено ${m.matureCount}`)
  assert(m.medianStability === 25, `медиана стаб. ожидалась 25, получено ${m.medianStability}`)
  group('maturity: медиана/квартили/зрелые считаются по review-словам, New исключён')
}

// ---- retentionByInterval -------------------------------------------------

function intervalChecks(): void {
  // каждая строка бакетируется по своему scheduled_days; typo и не-Review исключаются
  const j: JournalLine[] = [
    rev({ slug: 'a', prev_state: State.Review, scheduled_days: 2, rating: 3 }),   // 1-3 pass
    rev({ slug: 'b', prev_state: State.Review, scheduled_days: 5, rating: 1 }),   // 4-10 fail
    rev({ slug: 'c', prev_state: State.Review, scheduled_days: 20, rating: 4 }),  // 11-30 pass
    rev({ slug: 'd', prev_state: State.Review, scheduled_days: 45, rating: 3 }),  // 30+ pass
    rev({ slug: 'e', prev_state: State.Review, scheduled_days: 2, rating: 1, typo: true }), // исключить
    rev({ slug: 'g', prev_state: State.Learning, scheduled_days: 2, rating: 3 }), // не зрелый — исключить
  ]
  const ri = retentionByInterval(j)
  assert(ri['1-3'].n === 1 && ri['1-3'].pct === 100, `1-3: n=${ri['1-3'].n} pct=${ri['1-3'].pct}`)
  assert(ri['4-10'].n === 1 && ri['4-10'].pct === 0, `4-10: n=${ri['4-10'].n} pct=${ri['4-10'].pct}`)
  assert(ri['11-30'].n === 1 && ri['11-30'].pct === 100, `11-30: n=${ri['11-30'].n}`)
  assert(ri['30+'].n === 1 && ri['30+'].pct === 100, `30+: n=${ri['30+'].n}`)
  const total = ri['1-3'].n + ri['4-10'].n + ri['11-30'].n + ri['30+'].n
  assert(total === 4, `суммарное n по бакетам ожидалось 4 (typo и learning исключены), получено ${total}`)

  // реконструкция интервала из ts, когда scheduled_days нет
  const j2: JournalLine[] = [
    rev({ slug: 'r', prev_state: State.Learning, ts: '2026-09-01T10:00:00+03:00', rating: 3 }),
    rev({ slug: 'r', prev_state: State.Review, ts: '2026-09-04T10:00:00+03:00', rating: 3 }), // gap 3 дн → 1-3
  ]
  const ri2 = retentionByInterval(j2)
  assert(ri2['1-3'].n === 1, `реконструкция из ts: 1-3 n ожидалось 1, получено ${ri2['1-3'].n}`)
  group('retentionByInterval: бакеты по scheduled_days, реконструкция из ts, typo/learning вне зачёта')
}

// ---- retentionByLevel / Domain -------------------------------------------

function levelDomainChecks(): void {
  const cards = [vocab('a', reviewFsrs(30, 1), 2), vocab('b', reviewFsrs(30, 1), 3)]
  const j: JournalLine[] = [
    rev({ slug: 'a', prev_state: State.Review, level: 2, rating: 3 }),
    rev({ slug: 'a', prev_state: State.Review, level: 2, rating: 1 }),
    rev({ slug: 'b', prev_state: State.Review, rating: 4 }),  // level из карточки (frontmatter fallback)
  ]
  const rl = retentionByLevel(cards, j)
  assert(rl.get(2)!.n === 2 && rl.get(2)!.pct === 50, `L2: n=${rl.get(2)?.n} pct=${rl.get(2)?.pct}`)
  assert(rl.get(3)!.n === 1 && rl.get(3)!.pct === 100, `L3 (fallback по карточке): n=${rl.get(3)?.n}`)

  const jd: JournalLine[] = [
    rev({ slug: 'a', prev_state: State.Review, domain: 'II', rating: 3 }),
    rev({ slug: 'b', prev_state: State.Review, domain: 'II', rating: 1 }),
    rev({ slug: 'c', prev_state: State.Review, domain: 'CS', rating: 3 }),
  ]
  const rd = retentionByDomain(jd)
  assert(rd.get('II')!.n === 2 && rd.get('II')!.pct === 50, `домен II: n=${rd.get('II')?.n} pct=${rd.get('II')?.pct}`)
  assert(rd.get('CS')!.n === 1, `домен CS: n=${rd.get('CS')?.n}`)
  group('retentionByLevel/Domain: группировка по level (с fallback) и domain')
}

// ---- speedStats / typoSplit ----------------------------------------------

function speedTypoChecks(): void {
  const j: JournalLine[] = [
    rev({ slug: 'a', format: 'type', elapsed_ms: 2000 }),
    rev({ slug: 'b', format: 'type', elapsed_ms: 4000 }),
    rev({ slug: 'c', format: 'mc', elapsed_ms: 12000 }),   // медленный
    rev({ slug: 'd', format: 'intro', elapsed_ms: 3000 }), // intro исключается
  ]
  const sp = speedStats(j)
  assert(sp.n === 3, `speed n ожидалось 3 (intro вне), получено ${sp.n}`)
  assert(sp.medianMs === 4000, `медиана ожидалась 4000, получено ${sp.medianMs}`)
  assert(Math.abs(sp.slowShare - 1 / 3) < 0.01, `slowShare ожидалась ~0.33, получено ${sp.slowShare}`)
  assert(sp.byFormat.type.n === 2 && sp.byFormat.mc.n === 1, 'byFormat разбивка')

  const jt: JournalLine[] = [
    rev({ slug: 'a', format: 'type', correct: true, typo: true }),   // опечатка
    rev({ slug: 'b', format: 'type', correct: false }),              // незнание
    rev({ slug: 'c', format: 'type', correct: false }),              // незнание
    rev({ slug: 'd', format: 'type', correct: true }),               // верно — ни то, ни то
    rev({ slug: 'e', format: 'mc', correct: false }),                // не type — вне
  ]
  const ts = typoSplit(jt)
  assert(ts.typos === 1 && ts.realMisses === 2, `typoSplit ожидалось {1,2}, получено {${ts.typos},${ts.realMisses}}`)
  group('speedStats/typoSplit: intro вне скорости, опечатки отделены от незнания')
}

// ---- pace ----------------------------------------------------------------

function paceChecks(): void {
  const now = new Date(2026, 8, 1, 12, 0, 0)   // 01.09.2026
  const today = dayKey(now)
  const d3 = addDaysKey(today, -3)
  const d10 = addDaysKey(today, -10)
  const cards = [vocab('ready', reviewFsrs(300, 4), 1)]  // 1 готово
  const grad = (slug: string, day: string): JournalLine =>
    rev({ slug, day, prev_state: State.Learning, new_state: State.Review, rating: 3 })
  const j: JournalLine[] = [
    grad('a', today), grad('b', d3),      // в окне 7 дн
    grad('c', d10),                        // только в окне 14 дн
    grad('a', d3),                         // дубль слова a — считаем один раз
  ]
  const pc = pace(cards, j, PRIMARY_DATE, now)
  assert(pc.ready === 1, `pace.ready ожидалось 1, получено ${pc.ready}`)
  assert(pc.actual7 === 2, `actual7 ожидалось 2 (a,b), получено ${pc.actual7}`)
  assert(pc.actual14 === 3, `actual14 ожидалось 3 (a,b,c), получено ${pc.actual14}`)
  assert(pc.remaining === TARGET_WORDS - 1, `remaining ожидалось ${TARGET_WORDS - 1}, получено ${pc.remaining}`)
  assert(pc.neededPerDay > 0 && pc.daysLeft > 0, 'neededPerDay/daysLeft положительны')
  assert(pc.verdict === 'behind', `при большом дефиците вердикт behind, получено ${pc.verdict}`)
  group('pace: дефицит, темп (graduation в Review, дубль слова один раз), вердикт')
}

// ---- snapshot roundtrip --------------------------------------------------

function snapshotChecks(): void {
  const cards = [vocab('ready', reviewFsrs(300, 4), 1), vocab('stale', reviewFsrs(1, 60), 2)]
  const snap = buildMetricsSnapshot(cards, [], new Date(2026, 8, 1, 12, 0, 0))
  assert(typeof snap.day === 'string' && snap.ready === 1, `snapshot day/ready: ${snap.day}/${snap.ready}`)

  // одна строка в день: повторный append того же дня ничего не добавляет
  const a1 = appendDailySnapshot('', snap)
  assert(a1.appended && a1.text.trim().split('\n').length === 1, 'первый append добавил строку')
  const a2 = appendDailySnapshot(a1.text, snap)
  assert(!a2.appended && a2.text === a1.text, 'повторный append того же дня не дублирует')

  const snap2 = { ...snap, day: addDaysKey(snap.day, 1) }
  const a3 = appendDailySnapshot(a1.text, snap2)
  assert(a3.appended, 'снимок другого дня добавляется')
  const parsed = parseMetrics(a3.text)
  assert(parsed.length === 2 && parsed[0].day < parsed[1].day, 'parseMetrics: 2 строки, отсортированы по дню')
  group('snapshot: одна строка в день, parse/append roundtrip')
}

function main(): void {
  console.log('SRS metrics — examReady/maturity/pace/retention/speed/typo/snapshot')
  examReadyChecks()
  maturityChecks()
  intervalChecks()
  levelDomainChecks()
  speedTypoChecks()
  paceChecks()
  snapshotChecks()
  console.log(`\nВсе проверки метрик пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ МЕТРИК УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
