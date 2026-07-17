import { useApp, setScreen } from '../lib/store'
import { streak } from '../lib/journal'
import { Flame, Timer, Check, Bolt } from '../components/Icon'

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
  const ss = Math.floor((r.durMs % 60000) / 1000)

  return (
    <div className="screen">
      <div className="sum-wrap">
        <div className="sum-art"><Flame size={88} off={st.days === 0} /></div>
        <div>
          <h2 className="sum-title">{r.queueEmpty ? 'Очередь пуста!' : 'Сессия завершена'}</h2>
          <div className="sum-sub">{st.todayDone ? `серия ${st.days} — день зачтён` : 'день ещё не зачтён'}</div>
        </div>
        <div className="tiles">
          <div className="tile tile-green">
            <div className="tile-head">Новых</div>
            <div className="tile-body"><Bolt size={17} />{r.newSeen}</div>
          </div>
          <div className="tile tile-blue">
            <div className="tile-head">Повторов</div>
            <div className="tile-body"><Check size={17} />{r.totalRev}</div>
          </div>
          {acc !== null && (
            <div className="tile tile-yellow">
              <div className="tile-head">Точность</div>
              <div className="tile-body">{acc}%</div>
            </div>
          )}
          <div className="tile tile-red">
            <div className="tile-head">Время</div>
            <div className="tile-body"><Timer size={16} />{mm}:{String(ss).padStart(2, '0')}</div>
          </div>
        </div>
        <button className="btn btn-green btn-lg" onClick={() => setScreen('home')}>Дальше</button>
      </div>
    </div>
  )
}
