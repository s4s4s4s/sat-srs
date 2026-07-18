import { useApp, setScreen } from '../lib/store'
import { streak } from '../lib/journal'
import { Timer, Check, Bolt } from '../components/Icon'
import FlameBuddy from '../components/FlameBuddy'
import FjordScene from '../components/FjordScene'

export default function Summary() {
  const app = useApp()
  const r = app.session
  const pause = app.settings.pauseFrom && app.settings.pauseTo ? { from: app.settings.pauseFrom, to: app.settings.pauseTo } : null
  const st = streak(app.journal, undefined, pause)
  if (!r) {
    setScreen('home')
    return null
  }
  const acc = r.totalRev ? Math.round((r.passRev / r.totalRev) * 100) : null
  const mm = Math.floor(r.durMs / 60000)
  const ss = Math.floor((r.durMs % 60000) / 1000)

  return (
    <div className="screen">
      <FjordScene tall />
      <div className="sum-wrap">
        <div className="sum-art"><FlameBuddy size={104} mood="party" /></div>
        <div>
          <h2 className="sum-title">{r.queueEmpty ? 'Очередь пуста!' : 'Сессия завершена'}</h2>
          <div className="sum-sub">
            {st.todayDone ? `серия ${st.days} — день зачтён` : 'день ещё не зачтён'}
            {st.todayDone && st.toFreeze > 0 && ` · до ❄ ещё ${st.toFreeze} дн`}
          </div>
        </div>
        <div className="tiles">
          <div className="tile tile-new">
            <div className="tile-head">Новых</div>
            <div className="tile-body"><Bolt size={17} />{r.newSeen}</div>
          </div>
          <div className="tile tile-due">
            <div className="tile-head">Повторов</div>
            <div className="tile-body"><Check size={17} />{r.totalRev}</div>
          </div>
          {acc !== null && (
            <div className="tile tile-gold">
              <div className="tile-head">Точность</div>
              <div className="tile-body">{acc}%</div>
            </div>
          )}
          <div className="tile tile-time">
            <div className="tile-head">Время</div>
            <div className="tile-body"><Timer size={16} />{mm}:{String(ss).padStart(2, '0')}</div>
          </div>
        </div>
        <button className="btn btn-green btn-lg" onClick={() => setScreen('home')}>Дальше</button>
      </div>
    </div>
  )
}
