import { useApp, views, setScreen } from '../lib/store'
import { levelStats, activeLevel, sectionOf } from '../lib/scheduler'
import { ChevronLeft, Check, Lock, Bolt } from '../components/Icon'

/** Экран «Путь»: вертикальная лента уровней словаря (Duolingo-стиль).
    Порядок ввода гарантирован планировщиком — замок здесь визуальный маркер, не блокировка. */
export default function Path() {
  const app = useApp()
  const deck = views().filter(v => sectionOf(v) === 'rw')
  const stats = levelStats(deck)
  const active = activeLevel(deck)
  const nameOf = (lv: number) => app.levelNames[String(lv)] ?? `Уровень ${lv}`

  return (
    <div className="screen">
      <div className="page-title">
        <button className="iconbtn" onClick={() => setScreen('home')} aria-label="Назад"><ChevronLeft /></button>
        <h2>Путь</h2>
      </div>

      {stats.length === 0 ? (
        <div className="card"><div className="syncline">Уровни появятся после синхронизации колоды.</div></div>
      ) : (
        <div className="path-track">
          {stats.map(s => {
            const done = s.introduced >= s.total
            const isActive = s.level === active
            const locked = !done && !isActive && s.introduced === 0
            const pctIntro = Math.round((s.introduced / s.total) * 100)
            const pctMastery = Math.round((s.review / s.total) * 100)
            const cls = done ? 'done' : isActive ? 'active' : locked ? 'locked' : 'partial'
            return (
              <div key={s.level} className={`path-node ${cls}`}>
                <div className="path-ring" style={{ ['--p' as string]: `${pctIntro}%` } as React.CSSProperties}>
                  <span className="path-ring-mid">
                    {done ? <Check size={20} /> : locked ? <Lock size={18} /> : <Bolt size={18} />}
                  </span>
                </div>
                <div className="path-body">
                  <div className="path-name">
                    {nameOf(s.level)}
                    {isActive && <span className="path-tag">сейчас</span>}
                  </div>
                  <div className="path-sub">
                    введено {s.introduced}/{s.total}
                    {s.review > 0 && <span className="path-mastery"> · в памяти {pctMastery}%</span>}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
