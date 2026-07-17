import { useApp, views, setScreen, startSync } from '../lib/store'
import { homeCounts } from '../lib/scheduler'
import { streak, newIntroducedOn, minutesToday, MIN_MINUTES } from '../lib/journal'
import { dayKey } from '../lib/daytime'
import { Flame, Gear, Chart, Plus, Check } from '../components/Icon'

export default function Home() {
  const app = useApp()
  const today = dayKey()
  const budget = Math.max(0, app.settings.newPerDay - newIntroducedOn(app.journal, today))
  const c = homeCounts(views(), budget)
  const st = streak(app.journal)
  const mins = minutesToday(app.journal)
  const dueNow = c.learnDue + c.revDue + c.newAvail
  const minsDone = mins >= MIN_MINUTES || st.todayDone

  const syncText =
    app.syncStatus === 'syncing' ? 'Синхронизация…'
    : app.syncStatus === 'offline' ? 'Офлайн — изменения сохранены локально'
    : app.syncStatus === 'error' ? `Ошибка синхронизации: ${app.syncError}`
    : app.syncError ? app.syncError
    : app.lastSyncAt ? `Синхронизировано ${new Date(app.lastSyncAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })} · слов: ${c.total}`
    : ''

  return (
    <div className="screen">
      <div className="appbar">
        <h1 className="brand">SAT SRS</h1>
        <div className="spacer" />
        <span className={`chip chip-streak${st.days === 0 ? ' off' : ''}`}>
          <Flame size={26} off={st.days === 0} />
          {st.days}
        </span>
        <button className="iconbtn" onClick={() => setScreen('stats')} aria-label="Статистика"><Chart /></button>
        <button className="iconbtn" onClick={() => setScreen('settings')} aria-label="Настройки"><Gear /></button>
      </div>

      <div className="card hero">
        <div className="hero-head">
          <span className="hero-title">Сегодня</span>
          <span className="hero-sub">завтра: {c.revTomorrow} к повторению</span>
        </div>
        <div className="stats3">
          <div className="stat stat-red"><div className="n">{c.learnDue}</div><div className="t">учу</div></div>
          <div className="stat stat-blue"><div className="n">{c.revDue}</div><div className="t">повторить</div></div>
          <div className="stat stat-green"><div className="n">{c.newAvail}</div><div className="t">новых</div></div>
        </div>
        <div className="minbar-row">
          <div className="minbar"><div style={{ width: `${Math.min(100, (mins / MIN_MINUTES) * 100)}%` }} /></div>
          <span className={`minbar-label${minsDone ? ' done' : ''}`}>
            {st.todayDone ? 'день зачтён' : `${Math.floor(mins)}/${MIN_MINUTES} мин`}
          </span>
        </div>
      </div>

      <div className="home-actions">
        <button className="btn btn-green btn-lg" onClick={() => setScreen('review')} disabled={dueNow === 0}>
          {dueNow === 0 ? <><Check size={20} /> На сегодня всё</> : 'Начать'}
        </button>
        <div className="row">
          <button className="btn btn-white" onClick={() => setScreen('add')}><Plus size={18} /> Слово</button>
          <button className="btn btn-white" onClick={() => void startSync()}>Синк</button>
        </div>
      </div>

      <div className={`syncline${app.syncStatus === 'error' ? ' err' : ''}`}>{syncText}</div>
    </div>
  )
}
