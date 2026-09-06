/**
 * Тесты чистых функций метрик (src/lib/metrics.ts) — без React/IndexedDB. Гоняют РЕАЛЬНЫЕ
 * функции: examReady (через ts-fsrs get_retrievability), maturity/reviewCount, pace,
 * retentionByInterval, retentionByLevel/Domain, speedStats, typoSplit, gaveUpShare,
 * appendDailySnapshot/parseMetrics.
 *
 * Отдельно закреплено поведение, введённое 17.08.2026: цель (TARGET_REVIEW/TARGET_MATURE
 * вместо снятых «400 готовых»), бакет «меньше суток» и запрет показывать процент при малом n.
 *
 * Запуск: `npm run test:metrics` (esbuild бандлит файл и node его исполняет).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fsrs, generatorParameters, State, type Card as FsrsCard } from 'ts-fsrs'
import type { CardView, JournalLine } from '../src/lib/types'
import {
  examReady, maturity, pace, reviewCount, retentionByInterval, retentionByLateness, retentionByLevel, retentionByDomain,
  planVsFact,
  speedStats, typoSplit, gaveUpShare, cuedStats, appendDailySnapshot, parseMetrics, buildMetricsSnapshot,
  intervalBucketOf, enoughForPct, isLeechCard, orphanedLines,
  PRIMARY_DATE, EXAM_DATE, NEW_STOP_DATE, NEW_STOP_BY_SECTION, nextAttempt, TARGET_REVIEW, TARGET_MATURE, MIN_N_FOR_PCT,
  MATURE_STABILITY_DAYS, READY_R,
  capacityEstimate, gradesPerCard, CAPACITY_WINDOW_DAYS, RULE_GRADES
} from '../src/lib/metrics'
import { dayKey, addDaysKey } from '../src/lib/daytime'
import { parseMd, cardView } from '../src/lib/yamlfm'
import { parseNdjson, toNdjson } from '../src/lib/journal'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }
function skip(name: string): void { console.log(`  ⚠ ${name}`) }

// ---- фабрики -------------------------------------------------------------

function vocab(slug: string, f: FsrsCard, level = 1, extra: Partial<CardView> = {}): CardView {
  return {
    path: `deck/${slug}.md`, slug, word: slug, pos: 'adj', context: '', contexts: [],
    meaning_en: '', meaning_ru: 'значение', roots: '', source: 'test', added: '2026-07-01',
    level, kind: 'vocab', domain: '', confusables: [], synonyms: [], from_mark: [], leech: '', choices: [], answerText: '',
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

/** Карточка в Learning: не New (входит в maturity.n), но и не Review (в цель не засчитывается). */
function learningFsrs(stability = 0.5): FsrsCard {
  return { ...reviewFsrs(stability, 1), state: State.Learning, reps: 2 }
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
  // каждая строка бакетируется по своему elapsed_days (факт), а не scheduled_days (план);
  // typo и не-Review исключаются
  const j: JournalLine[] = [
    rev({ slug: 'a', prev_state: State.Review, elapsed_days: 2, rating: 3 }),   // 1-3 pass
    rev({ slug: 'b', prev_state: State.Review, elapsed_days: 5, rating: 1 }),   // 4-10 fail
    rev({ slug: 'c', prev_state: State.Review, elapsed_days: 20, rating: 4 }),  // 11-30 pass
    rev({ slug: 'd', prev_state: State.Review, elapsed_days: 45, rating: 3 }),  // 30+ pass
    rev({ slug: 'e', prev_state: State.Review, elapsed_days: 2, rating: 1, typo: true }), // исключить
    rev({ slug: 'g', prev_state: State.Learning, elapsed_days: 2, rating: 3 }), // не зрелый - исключить
  ]
  const ri = retentionByInterval(j)
  assert(ri['1-3'].n === 1 && ri['1-3'].pct === 100, `1-3: n=${ri['1-3'].n} pct=${ri['1-3'].pct}`)
  assert(ri['4-10'].n === 1 && ri['4-10'].pct === 0, `4-10: n=${ri['4-10'].n} pct=${ri['4-10'].pct}`)
  assert(ri['11-30'].n === 1 && ri['11-30'].pct === 100, `11-30: n=${ri['11-30'].n}`)
  assert(ri['30+'].n === 1 && ri['30+'].pct === 100, `30+: n=${ri['30+'].n}`)
  const total = ri['1-3'].n + ri['4-10'].n + ri['11-30'].n + ri['30+'].n
  assert(total === 4, `суммарное n по бакетам ожидалось 4 (typo и learning исключены), получено ${total}`)

  /* Ловушка, которую диагноз W3 нашёл на живом журнале: scheduled_days пишет план ДО
     следующего показа, а провал из Review сбрасывает его в 0 (следующий шаг лестницы короче
     суток) - это не имеет отношения к тому, через сколько дней случился ЭТОТ показ. Строка
     ниже врёт планом на 45 дней вперёд при фактическом интервале в 2 дня: если бы бакет
     читал scheduled_days, показ ушёл бы в «30+» вместо настоящего «1-3». */
  const jTrap: JournalLine[] = [
    rev({ slug: 'trap', prev_state: State.Review, scheduled_days: 45, elapsed_days: 2, rating: 3 })
  ]
  const riTrap = retentionByInterval(jTrap)
  assert(riTrap['1-3'].n === 1, `ловушка scheduled_days: ожидался бакет 1-3 по elapsed_days, n=${riTrap['1-3'].n}`)
  assert(riTrap['30+'].n === 0, `scheduled_days не должен читаться для бакета, 30+ n=${riTrap['30+'].n}`)

  // реконструкция интервала из ts, когда elapsed_days нет
  const j2: JournalLine[] = [
    rev({ slug: 'r', prev_state: State.Learning, ts: '2026-09-01T10:00:00+03:00', rating: 3 }),
    rev({ slug: 'r', prev_state: State.Review, ts: '2026-09-04T10:00:00+03:00', rating: 3 }), // gap 3 дн → 1-3
  ]
  const ri2 = retentionByInterval(j2)
  assert(ri2['1-3'].n === 1, `реконструкция из ts: 1-3 n ожидалось 1, получено ${ri2['1-3'].n}`)

  // elapsed_days = 0 - честный «меньше суток» (провал из Review, следующий шаг короче суток),
  // а не пропуск строки и не бакет «1-3»
  const j0: JournalLine[] = [
    rev({ slug: 'z', prev_state: State.Review, elapsed_days: 0, rating: 3 })
  ]
  const ri0 = retentionByInterval(j0)
  assert(ri0['<1'].n === 1, `elapsed_days=0 ожидался бакет «<1», получено n=${ri0['<1'].n}`)

  /* Внутридневной повтор - отдельный бакет, а не «1-3 дн». До 17.08.2026 они лежали
     вместе: из 70 показов бакета «1-3» 49 были внутридневными, и процент бакета не
     значил ничего. Граница ровно на сутках: 0,9 дн - «меньше суток», 1,0 - уже «1-3». */
  const j3: JournalLine[] = [
    rev({ slug: 'x', prev_state: State.Review, ts: '2026-09-01T10:00:00+03:00', rating: 3 }),
    rev({ slug: 'x', prev_state: State.Review, ts: '2026-09-01T10:20:00+03:00', rating: 1 }), // +20 мин
  ]
  const ri3 = retentionByInterval(j3)
  assert(ri3['<1'].n === 1, `внутридневной повтор ожидался в «<1», получено n=${ri3['<1'].n}`)
  assert(ri3['1-3'].n === 0, `внутридневной повтор не должен попадать в «1-3», получено n=${ri3['1-3'].n}`)
  assert(ri3['<1'].pct === 0, `«<1»: один провальный показ → 0%, получено ${ri3['<1'].pct}`)
  assert(intervalBucketOf(0.02) === '<1' && intervalBucketOf(0.9) === '<1',
    'интервал меньше суток → бакет «<1»')
  assert(intervalBucketOf(1) === '1-3' && intervalBucketOf(3) === '1-3',
    'ровно сутки и трое суток → бакет «1-3»')

  // elapsed_days обязан пережить запись/чтение ndjson - иначе бакетирование в проде тихо
  // откатилось бы к реконструкции по ts на каждой строке
  const roundtripLine = rev({ slug: 'rt', prev_state: State.Review, elapsed_days: 7, rating: 3 })
  const { lines: rtLines } = parseNdjson(toNdjson([roundtripLine]))
  assert(rtLines.length === 1 && rtLines[0].elapsed_days === 7,
    `elapsed_days должен пережить ndjson roundtrip, получено ${JSON.stringify(rtLines[0])}`)

  group('retentionByInterval: бакеты по elapsed_days (не по scheduled_days), ловушка плана закрыта, «меньше суток» отдельно, реконструкция из ts, typo/learning вне зачёта, roundtrip ndjson')
}

// ---- cued (C12) -------------------------------------------------------------

function cuedChecks(): void {
  // строка cued исключена из retentionByInterval так же, как twin (C12)
  const j: JournalLine[] = [
    rev({ slug: 'a', prev_state: State.Review, elapsed_days: 2, rating: 3 }),                     // 1-3 pass
    rev({ slug: 'b', prev_state: State.Review, elapsed_days: 2, rating: 2, cued: true }),          // исключить
  ]
  const ri = retentionByInterval(j)
  assert(ri['1-3'].n === 1, `cued обязан выпадать из retentionByInterval, n=${ri['1-3'].n}`)

  // cuedStats: доля показов формата type, взятых со скелета, за 7 и 30 дней
  const today = '2026-09-06'
  const jc: JournalLine[] = [
    rev({ slug: 'w1', day: today, format: 'type', rating: 2, cued: true }),
    rev({ slug: 'w2', day: today, format: 'type', rating: 3 }),
    rev({ slug: 'w3', day: addDaysKey(today, -3), format: 'type', rating: 2, cued: true }),
    rev({ slug: 'w4', day: addDaysKey(today, -20), format: 'type', rating: 2, cued: true }),  // вне 7 дней, внутри 30
    rev({ slug: 'w5', day: addDaysKey(today, -40), format: 'type', rating: 2, cued: true }),   // вне обоих окон
    rev({ slug: 'w6', day: today, format: 'mc', rating: 3, cued: true }),                       // не type - вне счёта
  ]
  const cs = cuedStats(jc, new Date(today + 'T12:00:00+03:00'))
  assert(cs.d7.shown === 3 && cs.d7.cued === 2, `d7 ожидалось shown=3 cued=2, получено ${JSON.stringify(cs.d7)}`)
  assert(cs.d30.shown === 4 && cs.d30.cued === 3, `d30 ожидалось shown=4 cued=3, получено ${JSON.stringify(cs.d30)}`)

  group('C12: cued исключён из retentionByInterval как twin, cuedStats считает окна 7 и 30 дней по format=type')
}

// ---- retentionByLateness ---------------------------------------------------

function latenessChecks(): void {
  // due предыдущей строки - 04.09, фактический показ - 06.09: просрочка 2 дня
  const jOverdue: JournalLine[] = [
    rev({ slug: 'p', day: '2026-09-01', prev_state: State.Learning, due: '2026-09-04T10:00:00+03:00', rating: 3 }),
    rev({ slug: 'p', day: '2026-09-06', prev_state: State.Review, rating: 3 })
  ]
  const rl = retentionByLateness(jOverdue)
  assert(rl.overdue.n === 1 && rl.overdue.pct === 100, `overdue: n=${rl.overdue.n} pct=${rl.overdue.pct}`)
  assert(rl.onTime.n === 0, `onTime ожидалось 0 при просрочке, получено ${rl.onTime.n}`)
  assert(rl.avgDelayDays === 2, `средняя просрочка ожидалась 2 дн, получено ${rl.avgDelayDays}`)

  // показ ровно в срок - onTime, просрочки нет
  const jOnTime: JournalLine[] = [
    rev({ slug: 'q', day: '2026-09-01', prev_state: State.Learning, due: '2026-09-04T10:00:00+03:00', rating: 3 }),
    rev({ slug: 'q', day: '2026-09-04', prev_state: State.Review, rating: 1 })
  ]
  const rl2 = retentionByLateness(jOnTime)
  assert(rl2.onTime.n === 1 && rl2.onTime.pct === 0, `onTime: n=${rl2.onTime.n} pct=${rl2.onTime.pct}`)
  assert(rl2.overdue.n === 0, `overdue ожидалось 0 при показе в срок, получено ${rl2.overdue.n}`)

  // learning-строка (не зрелый показ) вне счёта, даже если формально просрочена
  const jLearning: JournalLine[] = [
    rev({ slug: 'r', day: '2026-09-01', prev_state: State.New, due: '2026-09-04T10:00:00+03:00', rating: 3 }),
    rev({ slug: 'r', day: '2026-09-06', prev_state: State.Learning, rating: 3 })
  ]
  const rl3 = retentionByLateness(jLearning)
  assert(rl3.onTime.n === 0 && rl3.overdue.n === 0,
    `learning-строка обязана быть вне счёта, получено onTime=${rl3.onTime.n} overdue=${rl3.overdue.n}`)

  group('retentionByLateness: onTime/overdue по due предыдущей строки того же ключа, средняя просрочка, learning вне счёта')
}

// ---- planVsFact -------------------------------------------------------------

function planVsFactChecks(): void {
  // due предыдущей строки - в будущем (2026-09-25), но повтор случился в тот же день,
  // что и сама предыдущая строка (learning-шаг, prev_state ещё не Review): не должен
  // засчитываться ни как выполненный, ни тем более как "вовремя" - живой баг F38
  // (пара 'acknowledge' из журнала: два mc-показа 12 минут друг от друга).
  const jIntraday: JournalLine[] = [
    rev({ slug: 'acknowledge', day: '2026-09-04', ts: '2026-09-04T10:00:00+03:00',
      prev_state: State.Learning, due: '2026-09-25T10:00:00+03:00', rating: 3 }),
    rev({ slug: 'acknowledge', day: '2026-09-04', ts: '2026-09-04T10:12:00+03:00',
      prev_state: State.Learning, rating: 3 })
  ]
  const pvf1 = planVsFact(jIntraday, '2026-09-04', 6)
  assert(!pvf1.has('2026-09-04') || pvf1.get('2026-09-04')!.done === 0,
    `внутридневной повтор learning-шага не должен попадать в план/факт, получено ${JSON.stringify(pvf1.get('2026-09-04'))}`)

  // настоящий межднёвный показ вовремя: prev_state следующей строки - Review
  const jOnTime: JournalLine[] = [
    rev({ slug: 'q', day: '2026-09-01', prev_state: State.Learning, due: '2026-09-04T10:00:00+03:00', rating: 3 }),
    rev({ slug: 'q', day: '2026-09-04', prev_state: State.Review, rating: 3 })
  ]
  const pvf2 = planVsFact(jOnTime, '2026-09-04', 6)
  const d2 = pvf2.get('2026-09-04')
  assert(!!d2 && d2.done === 1 && d2.onTime === 1, `межднёвный показ вовремя ожидался done=1 onTime=1, получено ${JSON.stringify(d2)}`)

  // настоящий межднёвный показ с просрочкой
  const jOverdue: JournalLine[] = [
    rev({ slug: 'p', day: '2026-09-01', prev_state: State.Learning, due: '2026-09-04T10:00:00+03:00', rating: 3 }),
    rev({ slug: 'p', day: '2026-09-06', prev_state: State.Review, rating: 3 })
  ]
  const pvf3 = planVsFact(jOverdue, '2026-09-06', 6)
  const d3 = pvf3.get('2026-09-06')
  assert(!!d3 && d3.done === 1 && d3.onTime === 0 && d3.delaySum === 2,
    `межднёвный показ с просрочкой ожидался done=1 onTime=0 delaySum=2, получено ${JSON.stringify(d3)}`)

  group('planVsFact: внутридневной learning-повтор с future due не считается выполненным (F38), межднёвные показы вовремя/с просрочкой считаются как раньше')
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

  /* F20: медиана обязана считаться по answer_ms (чистое время ответа, без чтения
     вердикта/разбора), где оно есть, а для старых строк без него - по запасному
     elapsed_ms. Смешанная фикстура: две строки с answer_ms (2000, 4000) и одна
     старая строка без answer_ms, но с грязным elapsed_ms (30000, включает чтение
     разбора) - при правильном чтении медиана 3000 (по чистым парам), а не 4000
     (что дала бы грязная старая формула, читающая elapsed_ms всегда). */
  const jf: JournalLine[] = [
    rev({ slug: 'a', format: 'type', answer_ms: 2000, elapsed_ms: 6000 }),  // чистое 2000, грязное 6000
    rev({ slug: 'b', format: 'type', answer_ms: 4000, elapsed_ms: 9000 }),  // чистое 4000, грязное 9000
    rev({ slug: 'c', format: 'type', elapsed_ms: 30000 }),                  // старая строка, только грязное
  ]
  const spf = speedStats(jf)
  assert(spf.n === 3, `answer_ms fallback: n ожидалось 3, получено ${spf.n}`)
  assert(spf.medianMs === 4000, `answer_ms fallback: медиана из {2000,4000,30000} ожидалась 4000, получено ${spf.medianMs}`)
  assert(Math.abs(spf.cleanShare - 2 / 3) < 0.01, `cleanShare ожидалась ~0.67 (2 из 3 строк с answer_ms), получено ${spf.cleanShare}`)
  group('speedStats: answer_ms предпочитается elapsed_ms, доля чистых замеров считается верно')
}

// ---- pace ----------------------------------------------------------------

function paceChecks(): void {
  const now = new Date(2026, 8, 1, 12, 0, 0)   // 01.09.2026, ввод новых ещё открыт
  const today = dayKey(now)
  const d3 = addDaysKey(today, -3)
  const d10 = addDaysKey(today, -10)
  const cards = [
    vocab('ready', reviewFsrs(300, 4), 1),        // Review — в цель
    vocab('stale', reviewFsrs(1, 60), 1),         // Review — тоже в цель, зрелость тут не при чём
    vocab('learn', learningFsrs(), 1),            // Learning — ещё нет
    vocab('fresh', newFsrs(), 1)                  // New — нет
  ]
  const grad = (slug: string, day: string): JournalLine =>
    rev({ slug, day, prev_state: State.Learning, new_state: State.Review, rating: 3 })
  const j: JournalLine[] = [
    grad('a', today), grad('b', d3),      // в окне 7 дн
    grad('c', d10),                        // только в окне 14 дн
    grad('a', d3),                         // дубль слова a — считаем один раз
  ]
  const pc = pace(cards, j, NEW_STOP_DATE, now)
  assert(pc.inReview === 2, `pace.inReview ожидалось 2 (Learning и New вне цели), получено ${pc.inReview}`)
  assert(pc.actual7 === 2, `actual7 ожидалось 2 (a,b), получено ${pc.actual7}`)
  assert(pc.actual14 === 3, `actual14 ожидалось 3 (a,b,c), получено ${pc.actual14}`)
  assert(pc.remaining === TARGET_REVIEW - 2, `remaining ожидалось ${TARGET_REVIEW - 2}, получено ${pc.remaining}`)
  // 01.09 12:00 → 19.09 00:00 = 17,5 суток, вверх = 18. Считаем до СТОПА ВВОДА,
  // а не до экзамена, и граница включает саму дату (последний день ввода — 18.09).
  assert(pc.daysLeft === 18, `daysLeft до стопа ввода ожидалось 18, получено ${pc.daysLeft}`)
  assert(pc.neededPerDay > 0, `neededPerDay ожидался положительным, получено ${pc.neededPerDay}`)
  assert(pc.verdict === 'behind', `при большом дефиците вердикт behind, получено ${pc.verdict}`)

  // после стопа ввода темп не считается: закрывать дефицит уже нечем
  const after = new Date(2026, 8, 25, 12, 0, 0)   // 25.09.2026
  const pcAfter = pace(cards, j, NEW_STOP_DATE, after)
  assert(pcAfter.verdict === 'closed', `после стопа ожидался вердикт closed, получено ${pcAfter.verdict}`)
  assert(pcAfter.daysLeft === 0 && pcAfter.neededPerDay === 0 && pcAfter.daysBehind === null,
    `после стопа ожидалось daysLeft=0, neededPerDay=0, daysBehind=null; получено ${pcAfter.daysLeft}/${pcAfter.neededPerDay}/${pcAfter.daysBehind}`)

  /* Граница ровно там же, где у планировщика (newIntroAllowed): 18.09 — последний
     рабочий день ввода, 19.09 бюджет новых уже нулевой. Разъедься эти две границы —
     и экран будет требовать «+N слов в день» в день, когда урок новых не выдаёт. */
  const lastDay = pace(cards, j, NEW_STOP_DATE, new Date(2026, 8, 18, 12, 0, 0))
  assert(lastDay.verdict !== 'closed' && lastDay.daysLeft === 1,
    `18.09 — последний день ввода, ожидался открытый ввод с daysLeft=1, получено ${lastDay.verdict}/${lastDay.daysLeft}`)
  const onStop = pace(cards, j, NEW_STOP_DATE, new Date(2026, 8, 19, 12, 0, 0))
  assert(onStop.verdict === 'closed', `в сам день стопа ожидался closed, получено ${onStop.verdict}`)
  group('pace: темп к стопу ввода новых, Learning/New вне цели, после стопа — closed')
}

/**
 * E3: метрика считается на БЛИЖАЙШУЮ попытку, а не на константу первой.
 *
 * examReady(cards) без даты 05.10 считала готовность на 03.10, то есть на вчера: число
 * «готово к экзамену» переставало значить что-либо ровно тогда, когда до второй попытки
 * остаётся ещё месяц работы. Дата по умолчанию теперь приходит из nextAttempt.
 */
function nextAttemptMetricChecks(): void {
  const cards = [
    vocab('ready', reviewFsrs(300, 4), 1),
    vocab('mid', reviewFsrs(40, 4), 1),
    vocab('stale', reviewFsrs(6, 4), 1)
  ]

  assert(nextAttempt(new Date(2026, 8, 5, 12, 0, 0)).getTime() === PRIMARY_DATE.getTime(), 'до 03.10 метрика считает на первую попытку')
  assert(nextAttempt(new Date(2026, 9, 5, 12, 0, 0)).getTime() === EXAM_DATE.getTime(), '05.10 ближайшая попытка - 07.11')

  const наПопытку = examReady(cards, nextAttempt(new Date(2026, 9, 5, 12, 0, 0)))
  const наНоябрь = examReady(cards, EXAM_DATE)
  const наОктябрь = examReady(cards, PRIMARY_DATE)
  assert(наПопытку.ready === наНоябрь.ready, '05.10 готовность обязана считаться на 07.11')
  assert(наОктябрь.ready > наНоябрь.ready, 'предпосылка проверки: на более дальнюю дату готовых меньше, иначе она ничего не различает')

  // сегодняшний вызов без даты обязан идти по ближайшей попытке, а не по константе
  assert(examReady(cards).ready === examReady(cards, nextAttempt()).ready, 'examReady без даты считает на ближайшую попытку')

  /* Структурно: дата по умолчанию именно nextAttempt(). Значение проверить нечем -
     сегодня ближайшая попытка и есть PRIMARY_DATE, и откат к константе тест бы не заметил
     до 03.10, то есть ровно до того дня, ради которого правка сделана. */
  const src = readFileSync(path.join(process.cwd(), 'src', 'lib', 'metrics.ts'), 'utf8')
  assert(/export function examReady\(cards: CardView\[\], date: Date = nextAttempt\(\)\)/.test(src),
    'сигнатура examReady обязана брать дату по умолчанию у nextAttempt()')

  // темп ввода считается по стопу СЛОВ: стопов теперь четыре, у каждого раздела свой (A8)
  assert(NEW_STOP_DATE.getTime() === NEW_STOP_BY_SECTION.rw.getTime(), 'pace обязан считать по стопу словаря')
  assert(NEW_STOP_BY_SECTION.grammar > NEW_STOP_BY_SECTION.rw, 'A8: грамматика вводится дольше словаря')
  const j: JournalLine[] = []
  const поУмолчанию = pace(cards, j, undefined, new Date(2026, 8, 25, 12, 0, 0))
  assert(поУмолчанию.verdict === 'closed', 'pace без явного стопа берёт стоп слов: 25.09 ввод слов уже закрыт')
  const доСтопа = pace(cards, j, undefined, new Date(2026, 8, 18, 12, 0, 0))
  assert(доСтопа.verdict !== 'closed' && доСтопа.daysLeft === 1, '18.09 - последний день ввода слов')

  group('E3: examReady и pace берут даты у ближайшей попытки и у стопа своего раздела')
}

// ---- capacityEstimate / gradesPerCard (WS7, D7) ---------------------------

/**
 * D7: главное число - готовность к попытке по прогнозной R, цель от измеренной ёмкости.
 * 06.09.2026 отчёт требовал «довести ещё 219, +14,6/день, отстаёшь на 68 дн» при 28 днях
 * до попытки и медиане 2,4 доведения в день - цель разъехалась с ёмкостью вчетверо, тот же
 * прецедент, что и с «400 готовых слов» 17.08.2026 (см. комментарий в metrics.ts).
 */
function m9CapacityChecks(): void {
  const now = new Date(2026, 8, 15, 12, 0, 0)   // 15.09.2026
  const today = dayKey(now)

  // ---- capacityEstimate: медиана оценок в учебный день × оставшиеся учебные дни.
  // Фикстура «занимался через день» на окне 14 дней: 7 учебных дней по 34 оценки.
  const studyJournal: JournalLine[] = []
  for (let i = 0; i < 14; i += 2) {
    const day = addDaysKey(today, -i)
    for (let k = 0; k < 34; k++) studyJournal.push(rev({ day, rating: 3 }))
  }
  const until = new Date(now.getTime() + 14 * 86400_000)   // 14 дней до until
  const ce = capacityEstimate(studyJournal, now, until, 14)
  assert(Math.abs(ce.studyFrequency - 0.5) < 1e-9, `M9: частота учебных дней «через день» ожидалась 0.5, получено ${ce.studyFrequency}`)
  assert(ce.gradesPerStudyDay === 34, `M9: медиана оценок в учебный день ожидалась 34, получено ${ce.gradesPerStudyDay}`)
  assert(ce.studyDaysRemaining === 7, `M9: 14 дней до until при частоте 0.5 - ожидалось 7 учебных дней, получено ${ce.studyDaysRemaining}`)
  assert(ce.capacity === 238, `M9: capacity ожидалась 238 (34 × 7), получено ${ce.capacity}`)

  // ---- gradesPerCard: медиана по скользящему окну, а не по всей истории.
  // Хвост пиявки (50 оценок одного слова) лежит ЗА окном и не должен сдвинуть медиану.
  const cardJournal: JournalLine[] = []
  const addGrades = (slug: string, n: number, day: string) => {
    for (let k = 0; k < n; k++) cardJournal.push(rev({ slug, day, rating: 3 }))
  }
  addGrades('a', 3, addDaysKey(today, -1))
  addGrades('b', 5, addDaysKey(today, -2))
  addGrades('c', 7, addDaysKey(today, -3))
  addGrades('leech', 50, addDaysKey(today, -40))   // за окном CAPACITY_WINDOW_DAYS=21
  const gpc = gradesPerCard(cardJournal, now)
  assert(gpc === 5, `M9: gradesPerCard по окну - медиана {3,5,7}=5, хвост пиявки за окном игнорируется; получено ${gpc}`)

  // ---- pace: capacity/wordsAffordable/rulesAffordable приходят из тех же чистых функций
  const cards = [vocab('ready', reviewFsrs(300, 4), 1)]
  const stopDate = new Date(now.getTime() + 30 * 86400_000)
  const pc = pace(cards, studyJournal, stopDate, now)
  const ceDefault = capacityEstimate(studyJournal, now, stopDate)   // окно по умолчанию, как в pace()
  const gpcDefault = gradesPerCard(studyJournal, now) || 1
  assert(pc.capacity === ceDefault.capacity, `M9: pace.capacity обязан совпадать с capacityEstimate(окно ${CAPACITY_WINDOW_DAYS} дн по умолчанию), получено ${pc.capacity} против ${ceDefault.capacity}`)
  assert(pc.wordsAffordable === Math.floor(ceDefault.capacity / gpcDefault), `M9: wordsAffordable обязан быть floor(capacity / gradesPerCard), получено ${pc.wordsAffordable}`)
  assert(pc.rulesAffordable === Math.floor(ceDefault.capacity / RULE_GRADES), `M9: rulesAffordable обязан быть floor(capacity / RULE_GRADES), получено ${pc.rulesAffordable}`)

  // ---- examReady к дате из nextAttempt(now): при now 05.10 считает на 07.11
  const now0510 = new Date(2026, 9, 5, 12, 0, 0)
  const attempt = nextAttempt(now0510)
  assert(attempt.getTime() === EXAM_DATE.getTime(), 'M9: 05.10 ближайшая попытка - 07.11 (EXAM_DATE)')
  const cardsReady = [vocab('r1', reviewFsrs(300, 4), 1), vocab('r2', reviewFsrs(1, 60), 1)]
  const erAtAttempt = examReady(cardsReady, attempt)
  const erAt0711 = examReady(cardsReady, EXAM_DATE)
  assert(erAtAttempt.ready === erAt0711.ready, 'M9: examReady(cards, nextAttempt(05.10)) обязан считать готовность на 07.11')

  group('M9: capacityEstimate/gradesPerCard - ёмкость от измеренного темпа, pace несёт capacity/wordsAffordable/rulesAffordable')
}

// ---- цель: Review + зрелые ------------------------------------------------

function goalChecks(): void {
  assert(TARGET_REVIEW >= 250 && TARGET_REVIEW <= 300,
    `TARGET_REVIEW должен лежать в коридоре 250–300 (решение 17.08.2026), получено ${TARGET_REVIEW}`)
  assert(TARGET_MATURE === 150, `TARGET_MATURE ожидалось 150, получено ${TARGET_MATURE}`)
  assert(TARGET_MATURE < TARGET_REVIEW, 'зрелых не может быть больше, чем доведённых до review')
  assert(NEW_STOP_DATE < PRIMARY_DATE, 'стоп ввода новых обязан быть раньше первой попытки')
  // введённое в день стопа ещё успевает дойти до review, но НЕ успевает созреть за 21 день —
  // именно поэтому целей две, а не одна
  const daysToExam = Math.round((PRIMARY_DATE.getTime() - NEW_STOP_DATE.getTime()) / 86400_000)
  assert(daysToExam < MATURE_STABILITY_DAYS,
    `между стопом и экзаменом ${daysToExam} дн — если бы их было >= ${MATURE_STABILITY_DAYS}, стоп стоял бы слишком рано`)

  const cards = [
    vocab('a', reviewFsrs(30, 1), 1),
    vocab('b', reviewFsrs(3, 1), 1),
    vocab('learn', learningFsrs(), 1),
    vocab('new', newFsrs(), 1),
    vocab('susp', reviewFsrs(30, 1), 1, { suspended: true }),
    vocab('math', reviewFsrs(30, 1), 1, { kind: 'math' })
  ]
  assert(reviewCount(cards) === 2, `reviewCount ожидалось 2 (без Learning/New/suspended/math), получено ${reviewCount(cards)}`)
  const m = maturity(cards)
  assert(m.reviewCount === 2 && m.matureCount === 1 && m.n === 3,
    `maturity: ожидалось reviewCount=2 matureCount=1 n=3, получено ${m.reviewCount}/${m.matureCount}/${m.n}`)
  group('цель: TARGET_REVIEW/TARGET_MATURE, стоп ввода раньше экзамена, числители целей')
}

// ---- малая выборка --------------------------------------------------------

function smallSampleChecks(): void {
  assert(MIN_N_FOR_PCT >= 20, `порог показа процента не должен опускаться ниже 20, стоит ${MIN_N_FOR_PCT}`)
  // ровно тот случай, что поднял ложную тревогу 17.08.2026: «retention 50%» по четырём показам
  assert(!enoughForPct(4), 'процент по n=4 показывать нельзя')
  assert(!enoughForPct(MIN_N_FOR_PCT - 1), `n=${MIN_N_FOR_PCT - 1} — всё ещё мало данных`)
  assert(enoughForPct(MIN_N_FOR_PCT), `n=${MIN_N_FOR_PCT} — процент уже показываем`)
  group('малая выборка: процент прячется, пока n < MIN_N_FOR_PCT')
}

// ---- snapshot roundtrip --------------------------------------------------

function snapshotChecks(): void {
  const now = new Date(2026, 8, 1, 12, 0, 0)
  const today = dayKey(now)
  const leechCard = vocab('leech', { ...reviewFsrs(1, 3), reps: 9 }, 2)   // reps>=8 при stability<2
  assert(isLeechCard(leechCard), 'setup: карточка обязана считаться пиявкой')
  const cards = [vocab('ready', reviewFsrs(300, 4), 1), vocab('stale', reviewFsrs(1, 60), 2), leechCard]

  /* Слепой снимок ничего не доказывает: до 17.08.2026 в нём не было ни чтения, ни пиявок,
     ни «не помню» — то есть ряд не мог ответить, стало ли лучше. */
  const jSnap: JournalLine[] = [
    rev({ slug: 'ready', day: today, format: 'mc', rating: 1, gave_up: true }),
    rev({ slug: 'ready', day: today, format: 'type', rating: 3 }),
    rev({ slug: 'x', day: today, format: 'intro', rating: 3 }),          // знакомство вне знаменателя
    rev({ type: 'read', day: today, read_min: 25 }),                      // чтение
    rev({ slug: 'y', day: addDaysKey(today, -1), format: 'mc', rating: 1, gave_up: true }), // вчера — не в дневной снимок
  ]
  const full = buildMetricsSnapshot(cards, jSnap, now)
  assert(full.readMinutes === 25, `readMinutes ожидалось 25, получено ${full.readMinutes}`)
  assert(full.leeches === 1, `leeches ожидалось 1, получено ${full.leeches}`)
  assert(full.gaveUpN === 2 && full.gaveUpShare === 0.5,
    `«не помню» за день ожидалось 1 из 2 (0.5), получено ${full.gaveUpShare} при n=${full.gaveUpN}`)
  assert(full.inReview === 3, `inReview ожидалось 3, получено ${full.inReview}`)
  const gu = gaveUpShare(jSnap)
  assert(gu.n === 3 && gu.gaveUp === 2, `без дня считаем всю историю: ожидалось 2 из 3, получено ${gu.gaveUp} из ${gu.n}`)

  const snap = buildMetricsSnapshot(cards, [], now)
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

// ---- orphanedLines ---------------------------------------------------------

function orphanedLinesChecks(): void {
  const cards = [
    vocab('a', reviewFsrs(30, 1)),
    vocab('b', reviewFsrs(30, 1)),
    // переработка пиявки: исходного слага 'bolster' в колоде уже нет, вместо него -2 с source releech
    vocab('bolster-2', reviewFsrs(30, 1), 1, { source: 'releech' })
  ]
  const j: JournalLine[] = [
    rev({ slug: 'a', rating: 3 }),
    rev({ slug: 'ghost1', rating: 1 }),
    rev({ slug: 'ghost1', rating: 3 }),
    rev({ slug: 'ghost2', rating: 4 }),
    rev({ slug: 'b', rating: 3 }),
    rev({ type: 'session', slug: undefined, dur_ms: 90000 }),      // без slug - вне счёта
    rev({ type: 'reading', slug: '1-01-reef', marks: 2 }),          // слаг ТЕКСТА чтения, не карточки - вне total
    rev({ slug: 'bolster', rating: 1 }),
    rev({ slug: 'bolster', rating: 3 })
  ]
  const orph = orphanedLines(cards, j)
  assert(orph.total === 7, `total (review-строк со slug) ожидалось 7, получено ${orph.total}`)
  assert(orph.n === 3, `n (осиротевших, без переработанных) ожидалось 3, получено ${orph.n}`)
  assert(Math.abs(orph.share - 0.43) < 0.01, `share ожидалась ~0.43 (3 из 7), получено ${orph.share}`)
  assert(orph.slugs.length === 2, `слагов ожидалось 2 (ghost1, ghost2), получено ${orph.slugs.length}`)
  assert(orph.slugs[0].slug === 'ghost1' && orph.slugs[0].n === 2,
    `по убыванию первым ожидался ghost1 ×2, получено ${JSON.stringify(orph.slugs[0])}`)
  assert(orph.slugs[1].slug === 'ghost2' && orph.slugs[1].n === 1,
    `вторым ожидался ghost2 ×1, получено ${JSON.stringify(orph.slugs[1])}`)
  assert(orph.reworked.length === 1 && orph.reworked[0].slug === 'bolster' && orph.reworked[0].n === 2,
    `bolster обязан уйти в reworked ×2, а не в slugs, получено ${JSON.stringify(orph.reworked)}`)
  assert(!orph.slugs.some(s => s.slug === 'bolster'), 'bolster не должен попасть в slugs (это переработка, а не потеря)')

  // все слаги журнала есть в колоде - ноль, без ложной тревоги на пустом месте
  const clean = orphanedLines(cards, [rev({ slug: 'a' }), rev({ slug: 'b' })])
  assert(clean.n === 0 && clean.total === 2 && clean.slugs.length === 0 && clean.reworked.length === 0,
    `журнал без осиротевших: ожидалось n=0 total=2 slugs=[] reworked=[], получено ${JSON.stringify(clean)}`)

  group('orphanedLines: только review-строки в счёте, переработанные пиявки уходят в reworked, а не в slugs, чистый журнал даёт ноль')
}

// ---- живая колода (необязательно) ------------------------------------------

const DECK_DIR = 'C:/Users/sasha/dev/sat-deck/Учёба/Карточки'

/** Тот же приём, что в test/data.test.ts (liveDeckChecks): путь существует только на
 *  машине автора, поэтому группа пропускается (не падает), если каталога нет. */
function liveDeckOrphanCheck(): void {
  if (!existsSync(DECK_DIR)) {
    skip(`живая колода не найдена (${DECK_DIR}) — группа пропущена, это не эта машина`)
    return
  }
  const files = readdirSync(DECK_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'))
  const cards: CardView[] = []
  for (const f of files) {
    const text = readFileSync(path.join(DECK_DIR, f), 'utf8')
    const { fm, body, broken } = parseMd(text)
    if (broken) continue
    cards.push(cardView({ path: `Учёба/Карточки/${f}`, sha: null, fm, body, dirty: 0 }))
  }

  const journalDir = path.join(DECK_DIR, '_журнал')
  const monthFiles = existsSync(journalDir)
    ? readdirSync(journalDir).filter(f => /^\d{4}-\d{2}\.ndjson$/.test(f))
    : []
  let journal: JournalLine[] = []
  for (const jf of monthFiles) {
    const { lines } = parseNdjson(readFileSync(path.join(journalDir, jf), 'utf8'))
    journal = journal.concat(lines)
  }

  const orph = orphanedLines(cards, journal)
  assert(orph.n <= orph.total, `осиротевших не может быть больше строк со slug: n=${orph.n} total=${orph.total}`)
  assert(orph.slugs.reduce((a, s) => a + s.n, 0) === orph.n, 'сумма n по слагам должна сходиться с общим n')
  // слаги чтения ('1-01-…', слаг текста, не карточки) не должны просочиться в осиротевшие -
  // они отфильтрованы ограничением type: 'review'
  assert(!orph.slugs.some(s => /^\d+-\d+-/.test(s.slug)),
    `в orph.slugs не должно быть слагов текстов чтения, получено ${JSON.stringify(orph.slugs.filter(s => /^\d+-\d+-/.test(s.slug)))}`)
  console.log(`  i живая колода: ${cards.length} карточек, ${journal.length} строк журнала, осиротевших ${orph.n} из ${orph.total} (${Math.round(orph.share * 100)}%): ${orph.slugs.map(s => `${s.slug} ×${s.n}`).join(', ') || 'нет'}`)
  console.log(`  i переработанные пиявки (история обнулена осознанно): ${orph.reworked.map(s => `${s.slug} ×${s.n}`).join(', ') || 'нет'}`)

  group('orphanedLines на живой колоде: считает без ошибок, сумма по слагам сходится с общим счётом, слаги чтения не просачиваются')
}

function main(): void {
  console.log('SRS metrics — цель/examReady/maturity/pace/retention/speed/typo/snapshot')
  examReadyChecks()
  maturityChecks()
  goalChecks()
  smallSampleChecks()
  intervalChecks()
  cuedChecks()
  latenessChecks()
  planVsFactChecks()
  levelDomainChecks()
  speedTypoChecks()
  paceChecks()
  nextAttemptMetricChecks()
  m9CapacityChecks()
  snapshotChecks()
  orphanedLinesChecks()
  liveDeckOrphanCheck()
  console.log(`\nВсе проверки метрик пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ МЕТРИК УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
