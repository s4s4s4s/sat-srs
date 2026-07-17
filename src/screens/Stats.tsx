import { useApp, views, setScreen } from '../lib/store'
import { homeCounts } from '../lib/scheduler'
import { streak, trueRetention30, minutesToday, newIntroducedOn } from '../lib/journal'
import { dayKey } from '../lib/daytime'

export default function Stats() {
  const app = useApp()
  const today = dayKey()
  const budget = Math.max(0, app.settings.newPerDay - newIntroducedOn(app.journal, today))
  const c = homeCounts(views(), budget)
  const st = streak(app.journal)
  const ret = trueRetention30(app.journal)
  const mins = minutesToday(app.journal)

  return (
    <div className="screen">
      <div className="topbar">
        <button className="iconbtn" onClick={() => setScreen('home')} aria-label="Назад">←</button>
        <h2 className="sec" style={{ margin: 0 }}>Статистика</h2>
      </div>

      <div className="stat-grid">
        <div className="stat-cell"><div className="n">{c.learnDue + c.revDue + c.newAvail}</div><div className="t">due сегодня</div></div>
        <div className="stat-cell"><div className="n">{c.revTomorrow}</div><div className="t">due завтра</div></div>
        <div className="stat-cell"><div className="n">{c.newAvail}</div><div className="t">новых осталось</div></div>
        <div className="stat-cell"><div className="n">{ret.pct === null ? '—' : `${ret.pct}%`}</div><div className="t">retention 30 дн{ret.n ? ` (n=${ret.n})` : ''}</div></div>
        <div className="stat-cell"><div className="n">🔥 {st.days}</div><div className="t">серия дней</div></div>
        <div className="stat-cell"><div className="n">{Math.floor(mins)}</div><div className="t">минут сегодня</div></div>
      </div>

      <div className="panel">
        <h2 className="sec">Карточки · {c.total}</h2>
        <div className="due-nums">
          <div className="due-chip chip-green"><div className="n">{c.byState.new}</div><div className="t">новые</div></div>
          <div className="due-chip chip-red"><div className="n">{c.byState.learning}</div><div className="t">учатся</div></div>
          <div className="due-chip chip-blue"><div className="n">{c.byState.review}</div><div className="t">на повторе</div></div>
        </div>
      </div>
    </div>
  )
}
