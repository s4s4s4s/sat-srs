import { useApp, views, setScreen, startSync } from '../lib/store'
import { homeCounts } from '../lib/scheduler'
import { streak, newIntroducedOn, minutesToday, MIN_MINUTES } from '../lib/journal'
import { dayKey } from '../lib/daytime'

export default function Home() {
  const app = useApp()
  const today = dayKey()
  const budget = Math.max(0, app.settings.newPerDay - newIntroducedOn(app.journal, today))
  const c = homeCounts(views(), budget)
  const st = streak(app.journal)
  const mins = minutesToday(app.journal)
  const dueNow = c.learnDue + c.revDue + c.newAvail

  const syncText =
    app.syncStatus === 'syncing' ? 'Синхронизация…'
    : app.syncStatus === 'offline' ? 'Офлайн — изменения сохранены локально'
    : app.syncStatus === 'error' ? `Ошибка синхронизации: ${app.syncError}`
    : app.syncError ? app.syncError
    : app.lastSyncAt ? `Синхронизировано ${new Date(app.lastSyncAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`
    : ''

  return (
    <div className="screen">
      <div className="topbar">
        <h1 className="logo">SAT SRS</h1>
        <div className="spacer" />
        <button className="iconbtn" onClick={() => setScreen('stats')} aria-label="Статистика">📊</button>
        <button className="iconbtn" onClick={() => setScreen('settings')} aria-label="Настройки">⚙️</button>
      </div>

      <div className="panel streak-card">
        <div className="streak-flame">{st.days > 0 ? '🔥' : '🩶'}</div>
        <div>
          <div className="streak-n">{st.days}</div>
          <div className="streak-label">{st.todayDone ? 'серия · сегодня зачтён' : 'серия дней'}</div>
        </div>
      </div>

      <div className="panel">
        <div className="due-nums">
          <div className="due-chip chip-red"><div className="n">{c.learnDue}</div><div className="t">учу</div></div>
          <div className="due-chip chip-blue"><div className="n">{c.revDue}</div><div className="t">повторить</div></div>
          <div className="due-chip chip-green"><div className="n">{c.newAvail}</div><div className="t">новых</div></div>
        </div>
        <div className="minbar"><div style={{ width: `${Math.min(100, (mins / MIN_MINUTES) * 100)}%` }} /></div>
        <div className="minbar-label">
          {mins >= MIN_MINUTES ? 'Защищённый минимум выполнен ✓' : `Минимум: ${Math.floor(mins)} / ${MIN_MINUTES} мин`}
        </div>
      </div>

      <div className="home-actions">
        <button className="btn btn-green" onClick={() => setScreen('review')} disabled={dueNow === 0}>
          {dueNow === 0 ? 'На сегодня всё ✓' : 'Начать повторение'}
        </button>
        <div className="row">
          <button className="btn btn-white" onClick={() => setScreen('add')}>+ Карточка</button>
          <button className="btn btn-white" onClick={() => void startSync()}>Синк</button>
        </div>
      </div>

      <div className={`syncline${app.syncStatus === 'error' ? ' err' : ''}`}>{syncText}</div>
      <div className="syncline">Карточек: {c.total} · завтра к повторению: {c.revTomorrow}</div>
    </div>
  )
}
