import { useApp, setScreen } from '../lib/store'
import { streak } from '../lib/journal'

export default function Summary() {
  const app = useApp()
  const r = app.session
  const st = streak(app.journal)
  if (!r) {
    setScreen('home')
    return null
  }
  const acc = r.totalRev ? Math.round((r.passRev / r.totalRev) * 100) : null
  const mm = Math.floor(r.durMs / 60000)
  const ss = Math.round((r.durMs % 60000) / 1000)

  return (
    <div className="screen">
      <div className="sum-wrap">
        <div className="sum-emoji">{r.queueEmpty ? '🎉' : '💪'}</div>
        <h2 className="sum-title">{r.queueEmpty ? 'Очередь пуста!' : 'Сессия завершена'}</h2>
        <div className="sum-grid">
          <div className="due-chip chip-green"><div className="n">{r.newSeen}</div><div className="t">новых</div></div>
          <div className="due-chip chip-blue"><div className="n">{r.reviews - r.newSeen}</div><div className="t">повторов</div></div>
          {acc !== null && <div className="due-chip chip-yellow"><div className="n">{acc}%</div><div className="t">точность</div></div>}
          <div className="due-chip chip-red"><div className="n">{mm}:{String(ss).padStart(2, '0')}</div><div className="t">время</div></div>
        </div>
        <div className="panel streak-card" style={{ justifyContent: 'center' }}>
          <div className="streak-flame">🔥</div>
          <div>
            <div className="streak-n">{st.days}</div>
            <div className="streak-label">{st.todayDone ? 'день зачтён' : `ещё ${'нужно позаниматься'}`}</div>
          </div>
        </div>
        <button className="btn btn-green" onClick={() => setScreen('home')}>Домой</button>
      </div>
    </div>
  )
}
