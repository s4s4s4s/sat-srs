import { useApp, views, setScreen } from '../lib/store'
import { homeCounts, loadForecast, sectionOf } from '../lib/scheduler'
import { streak, trueRetention30, minutesToday, newIntroducedOn, retentionByFormat, minutesByDay, emptyDays, isDayDone } from '../lib/journal'
import { dayKey, addDaysKey } from '../lib/daytime'
import { ChevronLeft, Flame } from '../components/Icon'

const FMT_NAMES: Record<string, string> = { mc: 'Выбор (MC)', type: 'Ввод', prep: 'Предлоги', reveal: 'Показ' }
const DOW = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']

export default function Stats() {
  const app = useApp()
  const today = dayKey()
  const budget = Math.max(0, app.settings.newPerDay - newIntroducedOn(app.journal, today))
  const all = views()
  const c = homeCounts(all, budget)
  const st = streak(app.journal)
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

  return (
    <div className="screen">
      <div className="page-title">
        <button className="iconbtn" onClick={() => setScreen('home')} aria-label="Назад"><ChevronLeft /></button>
        <h2>Статистика</h2>
      </div>

      <div className="stat-grid">
        <div className="stat-cell"><div className="n">{c.learnDue + c.revDue + c.newAvail}</div><div className="t">due сегодня</div></div>
        <div className="stat-cell"><div className="n">{c.revTomorrow}</div><div className="t">due завтра</div></div>
        <div className="stat-cell"><div className="n">{c.newAvail}</div><div className="t">новых осталось</div></div>
        <div className="stat-cell"><div className="n">{ret.pct === null ? '—' : `${ret.pct}%`}</div><div className="t">retention 30 дн{ret.n ? ` (n=${ret.n})` : ''}</div></div>
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
          {Object.entries(retF).map(([f, v]) => {
            const pct = Math.round((v.pass / v.total) * 100)
            return (
              <div key={f} className="fmt-row">
                <span className="fmt-name">{FMT_NAMES[f] ?? f}</span>
                <div className="fmt-track"><div className={`fmt-fill${pct < 70 ? ' low' : ''}`} style={{ width: `${pct}%` }} /></div>
                <span className="fmt-pct">{pct}% <span className="fmt-n">n={v.total}</span></span>
              </div>
            )
          })}
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
          слова/RW: {all.filter(v => sectionOf(v) === 'rw').length} · математика: {all.filter(v => sectionOf(v) === 'math').length}
        </div>
      </div>
    </div>
  )
}
