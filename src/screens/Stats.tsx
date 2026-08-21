import { useApp, views, setScreen } from '../lib/store'
import { homeCounts, loadForecast, sectionOf, newBudgetTotal } from '../lib/scheduler'
import { streak, trueRetention30, minutesToday, retentionByFormat, minutesByDay, emptyDays, isDayDone } from '../lib/journal'
import {
  pace, maturity, retentionByInterval, retentionByLevel, retentionByDomain,
  speedStats, enoughForPct, ddmm, PRIMARY_DATE, NEW_STOP_DATE,
  TARGET_REVIEW, TARGET_MATURE, MATURE_STABILITY_DAYS, INTERVAL_LABELS,
  type Bucketed, type IntervalBucket, type MetricSnapshot
} from '../lib/metrics'
import { dayKey, addDaysKey } from '../lib/daytime'
import { ChevronLeft, Flame } from '../components/Icon'

const FMT_NAMES: Record<string, string> = { mc: 'Выбор (MC)', type: 'Ввод', prep: 'Предлоги', reveal: 'Показ' }
const DOW = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']

/** Мини-график тренда: полилиния по ряду значений (null = пропуск дня). */
function Spark({ values, label }: { values: (number | null)[]; label: string }) {
  const pts = values.map((v, i) => ({ v, i })).filter(p => p.v !== null) as { v: number; i: number }[]
  if (pts.length < 2) return null
  const w = 160, h = 34, pad = 3
  const xs = values.length - 1 || 1
  const min = Math.min(...pts.map(p => p.v))
  const max = Math.max(...pts.map(p => p.v))
  const span = max - min || 1
  const x = (i: number) => pad + (i / xs) * (w - 2 * pad)
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad)
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1].v
  return (
    <div className="spark-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '4px 0' }}>
      <span className="fmt-name">{label}</span>
      <svg width={w} height={h} style={{ flex: '0 0 auto' }}>
        <path d={d} fill="none" stroke="#58cc02" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <span className="fmt-pct">{Math.round(last * 10) / 10}</span>
    </div>
  )
}

/**
 * Таблица разбивки retention: строки «метка · бар · pct (n)».
 *
 * Процент прячется, пока n < MIN_N_FOR_PCT (enoughForPct). 17.08.2026 строка
 * «4–10 дн — 50%» была посчитана по ЧЕТЫРЁМ показам и подняла тревогу на пустом
 * месте: при таком n оценка не отличима от любой другой. Само n показываем
 * всегда — и рядом с процентом тоже, чтобы вес цифры был виден без раскопок.
 */
function RetTable({ rows }: { rows: { label: string; b: Bucketed }[] }) {
  const shown = rows.filter(r => r.b.n > 0)
  if (!shown.length) return <div className="syncline">пока нет данных</div>
  return (
    <>
      {shown.map(r => {
        const ok = enoughForPct(r.b.n) && r.b.pct !== null
        const pct = r.b.pct ?? 0
        return (
          <div key={r.label} className="fmt-row">
            <span className="fmt-name">{r.label}</span>
            <div className="fmt-track"><div className={`fmt-fill${ok && pct < 70 ? ' low' : ''}`} style={{ width: ok ? `${pct}%` : 0 }} /></div>
            <span className="fmt-pct">{ok ? `${pct}%` : 'мало данных,'} <span className="fmt-n">n={r.b.n}</span></span>
          </div>
        )
      })}
    </>
  )
}

/** Ряд значений из истории снимков. Поля, добавленные позже (inReview, readMinutes),
 *  в старых строках отсутствуют — там разрыв графика, а не ноль: нуля в тот день не было,
 *  его просто не измеряли. */
function series(hist: MetricSnapshot[], pick: (s: MetricSnapshot) => number | undefined): (number | null)[] {
  return hist.map(s => {
    const v = pick(s)
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  })
}

export default function Stats() {
  const app = useApp()
  const today = dayKey()
  const all = views()
  const budget = newBudgetTotal(all, app.settings.newPerDay, app.journal, today)
  const c = homeCounts(all, budget)
  const pause = app.settings.pauseFrom && app.settings.pauseTo ? { from: app.settings.pauseFrom, to: app.settings.pauseTo } : null
  const st = streak(app.journal, undefined, pause)
  const ret = trueRetention30(app.journal)
  const retF = retentionByFormat(app.journal)
  const mins = minutesToday(app.journal)

  // прогноз нагрузки на 7 дней
  const fc = loadForecast(all, 7)
  const fcMax = Math.max(1, ...fc)
  const dowOf = (k: string) => DOW[(new Date(k + 'T12:00:00').getDay() + 6) % 7]

  // календарь: последние 28 учебных дней
  const minutes = minutesByDay(app.journal)
  const empty = emptyDays(app.journal)
  const days28 = Array.from({ length: 28 }, (_, i) => addDaysKey(today, i - 27))
  const firstDay = [...minutes.keys(), ...empty].sort()[0] ?? today

  /* Прогресс к экзамену. Цель с 17.08.2026 — не «400 готовых слов» (снята как
     недостижимая: слово созревает за 21 день стабильности, и введённое после ~12.09
     к 03.10 не успевает), а две величины: сколько карточек доведено до повторов и
     сколько из них зрелых. Темп считается к стопу ввода новых, а не к экзамену. */
  const pc = pace(all, app.journal, NEW_STOP_DATE)
  const mat = maturity(all)
  const ri = retentionByInterval(app.journal)
  const rl = retentionByLevel(all, app.journal)
  const rd = retentionByDomain(app.journal)
  const sp = speedStats(app.journal)
  const hist: MetricSnapshot[] = app.metricsHistory
  const paceVerdict = pc.verdict === 'ahead'
    ? 'идёшь с опережением'
    : pc.daysBehind === null ? 'темпа нет' : `отстаёшь на ${pc.daysBehind} дн`
  const intervalRows = (Object.keys(ri) as IntervalBucket[]).map(k => ({ label: INTERVAL_LABELS[k], b: ri[k] }))
  const levelRows = [...rl.entries()].sort((a, b) => a[0] - b[0]).map(([lv, b]) => ({ label: app.levelNames[String(lv)] ?? `Уровень ${lv}`, b }))
  const domainRows = [...rd.entries()].sort((a, b) => b[1].n - a[1].n).map(([d, b]) => ({ label: d, b }))

  return (
    <div className="screen s-stats">
      <div className="page-title">
        <button className="iconbtn" onClick={() => setScreen('home')} aria-label="Назад"><ChevronLeft /></button>
        <h2>Статистика</h2>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2 className="sec">Прогресс к экзамену</h2>
        <div className="minbar-row" style={{ marginTop: 2 }}>
          <div className="minbar"><div style={{ width: `${Math.min(100, (mat.reviewCount / TARGET_REVIEW) * 100)}%` }} /></div>
          <span className="minbar-label"><b>{mat.reviewCount}</b> / {TARGET_REVIEW}</span>
        </div>
        <div className="syncline" style={{ marginBottom: 6 }}>доведено до повторов — цель 250–300 слов к {ddmm(PRIMARY_DATE)}</div>
        <div className="minbar-row">
          <div className="minbar"><div style={{ width: `${Math.min(100, (mat.matureCount / TARGET_MATURE) * 100)}%` }} /></div>
          <span className="minbar-label"><b>{mat.matureCount}</b> / {TARGET_MATURE}</span>
        </div>
        <div className="syncline" style={{ marginBottom: 6 }}>из них зрелых — стабильность ≥ {MATURE_STABILITY_DAYS} дн, держатся без повторов</div>
        <div className="syncline">
          {pc.verdict === 'closed'
            ? <>ввод новых закрыт с {ddmm(NEW_STOP_DATE)} — дальше только дозревание</>
            : <>ввод новых закрывается {ddmm(NEW_STOP_DATE)}: довести ещё {pc.remaining} · нужно +{pc.neededPerDay}/день (осталось {pc.daysLeft} дн) · <b>{paceVerdict}</b></>}
        </div>
        <div className="syncline">
          темп: +{pc.actual7} за 7 дн · +{pc.actual14} за 14 дн · медиана стаб. {mat.medianStability} дн
        </div>
      </div>

      {hist.length >= 2 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2 className="sec">Тренды (по дням)</h2>
          <Spark values={series(hist, s => s.inReview)} label="доведено до повторов" />
          <Spark values={series(hist, s => s.matureCount)} label="зрелых слов" />
          <Spark values={series(hist, s => s.medianStability)} label="медиана стабильности" />
          <Spark values={series(hist, s => s.minutes)} label="минут карточек" />
          <Spark values={series(hist, s => s.readMinutes)} label="минут чтения" />
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <h2 className="sec">Retention по интервалу</h2>
        <div className="syncline" style={{ marginBottom: 6 }}>общий retention смешивает короткие и длинные интервалы — здесь они разведены</div>
        <RetTable rows={intervalRows} />
      </div>

      {levelRows.some(r => r.b.n > 0) && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2 className="sec">Retention по ступеням</h2>
          <RetTable rows={levelRows} />
        </div>
      )}

      {domainRows.some(r => r.b.n > 0) && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2 className="sec">Retention по домену</h2>
          <RetTable rows={domainRows} />
        </div>
      )}

      {sp.n > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2 className="sec">Скорость ответа</h2>
          <div className="syncline" style={{ marginBottom: 6 }}>
            медиана {(sp.medianMs / 1000).toFixed(1)} c · p90 {(sp.p90Ms / 1000).toFixed(1)} c · медленных (&gt;10 c): {Math.round(sp.slowShare * 100)}%
          </div>
          {Object.entries(sp.byFormat).map(([f, v]) => (
            <div key={f} className="fmt-row">
              <span className="fmt-name">{FMT_NAMES[f] ?? f}</span>
              <div className="fmt-track"><div className={`fmt-fill${v.slowShare > 0.3 ? ' low' : ''}`} style={{ width: `${Math.min(100, v.slowShare * 100)}%` }} /></div>
              <span className="fmt-pct">{(v.medianMs / 1000).toFixed(1)} c <span className="fmt-n">n={v.n}</span></span>
            </div>
          ))}
        </div>
      )}

      <div className="stat-grid">
        <div className="stat-cell"><div className="n">{c.learnDue + c.revDue + c.newAvail}</div><div className="t">due сегодня</div></div>
        <div className="stat-cell"><div className="n">{c.revTomorrow}</div><div className="t">due завтра</div></div>
        <div className="stat-cell"><div className="n">{c.newAvail}</div><div className="t">новых осталось</div></div>
        <div className="stat-cell">
          <div className="n">{enoughForPct(ret.n) && ret.pct !== null ? `${ret.pct}%` : '—'}</div>
          <div className="t">retention 30 дн{enoughForPct(ret.n) ? ` (n=${ret.n})` : ` · мало данных, n=${ret.n}`}</div>
        </div>
        <div className="stat-cell"><div className="n"><Flame size={22} off={st.days === 0} />{st.days}{st.freezes > 0 ? <span className="freeze">❄{st.freezes}</span> : null}</div><div className="t">серия дней</div></div>
        <div className="stat-cell"><div className="n">{Math.floor(mins)}</div><div className="t">минут сегодня</div></div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2 className="sec">Нагрузка на 7 дней</h2>
        <div className="fc-chart">
          {fc.map((n, i) => {
            const k = addDaysKey(today, i)
            return (
              <div key={k} className="fc-col">
                <div className="fc-n">{n || ''}</div>
                <div className="fc-bar-track">
                  <div className={`fc-bar${i === 0 ? ' today' : ''}`} style={{ height: `${Math.max(4, (n / fcMax) * 100)}%` }} />
                </div>
                <div className="fc-day">{i === 0 ? 'сег' : dowOf(k)}</div>
              </div>
            )
          })}
        </div>
      </div>

      {Object.keys(retF).length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2 className="sec">Точность по форматам · 30 дн</h2>
          {/* через RetTable — правило «процент только при n >= 20» на экране одно на все таблицы */}
          <RetTable rows={Object.entries(retF).map(([f, v]) => ({
            label: FMT_NAMES[f] ?? f,
            b: { pct: v.total ? Math.round((v.pass / v.total) * 100) : null, n: v.total, pass: v.pass }
          }))} />
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <h2 className="sec">Последние 4 недели</h2>
        <div className="cal-grid">
          {days28.map(d => {
            const done = isDayDone(d, minutes, empty)
            const isToday = d === today
            const beforeStart = d < firstDay
            return <span key={d} className={`cal-dot${done ? ' done' : ''}${isToday ? ' today' : ''}${beforeStart ? ' void' : ''}`} title={d} />
          })}
        </div>
      </div>

      <div className="card">
        <h2 className="sec">Карточки · {c.total}</h2>
        <div className="stats3">
          <div className="stat stat-green"><div className="n">{c.byState.new}</div><div className="t">новые</div></div>
          <div className="stat stat-red"><div className="n">{c.byState.learning}</div><div className="t">учатся</div></div>
          <div className="stat stat-blue"><div className="n">{c.byState.review}</div><div className="t">на повторе</div></div>
        </div>
        <div className="syncline" style={{ marginTop: 10 }}>
          слова: {all.filter(v => sectionOf(v) === 'rw').length} · грамматика: {all.filter(v => sectionOf(v) === 'grammar').length} · математика: {all.filter(v => sectionOf(v) === 'math').length}
        </div>
      </div>
    </div>
  )
}
