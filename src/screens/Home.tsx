import { useEffect } from 'react'
import { useApp, views, setScreen, startSync, startLesson, creditEmptyDay, unsyncedCount } from '../lib/store'
import { homeCounts, sectionOf, EXAM_DATE, type Section } from '../lib/scheduler'
import { streak, newIntroducedOn, minutesToday, MIN_MINUTES, type PauseRange } from '../lib/journal'
import { dayKey } from '../lib/daytime'
import { Flame, Gear, Chart, Plus, Check, Bolt } from '../components/Icon'
import FlameBuddy from '../components/FlameBuddy'
import FjordScene from '../components/FjordScene'
import type { CardView } from '../lib/types'

function SectionBlock({ title, icon, badge, glyph, cards, budget, onStart, onReview }: {
  title: string
  icon: React.ReactNode
  badge: string
  glyph: string
  cards: CardView[]
  budget: number
  onStart: () => void
  onReview: () => void
}) {
  const c = homeCounts(cards, budget)
  const reviewDue = c.learnDue + c.revDue
  const due = reviewDue + c.newAvail
  return (
    <div className="card section-card">
      <span className="sec-glyph" style={{ ['--rune-shape' as string]: glyph } as React.CSSProperties} />
      <div className="hero-head">
        <span className="hero-title section-title">
          <span className={`sec-badge ${badge}`}>{icon}</span> {title}
        </span>
        <span className="hero-sub">{c.total ? `${c.total} карт.` : 'пока пусто'}</span>
      </div>
      <div className="stats3">
        <div className={`stat stat-learn${c.learnDue ? '' : ' is-zero'}`}><div className="n">{c.learnDue}</div><div className="t">учу</div></div>
        <div className={`stat stat-due${c.revDue ? '' : ' is-zero'}`}><div className="n">{c.revDue}</div><div className="t">повторить</div></div>
        <div className={`stat stat-new${c.newAvail ? '' : ' is-zero'}`}><div className="n">{c.newAvail}</div><div className="t">новых</div></div>
      </div>
      {c.total > 0 && (
        <div className="mastery" title="доля слов в долгосрочной памяти">
          <div style={{ width: `${Math.round((c.byState.review / c.total) * 100)}%` }} />
        </div>
      )}
      <button className="btn btn-green section-btn" onClick={onStart} disabled={due === 0}>
        {due === 0 ? <><Check size={18} /> Всё повторено</> : `Учить · ${due}`}
      </button>
      {c.newAvail > 0 && reviewDue > 0 && (
        <button className="section-review" onClick={onReview}>Только повторить · {reviewDue}</button>
      )}
    </div>
  )
}

export default function Home() {
  const app = useApp()
  const today = dayKey()
  const budget = Math.max(0, app.settings.newPerDay - newIntroducedOn(app.journal, today))
  const all = views()
  const rw = all.filter(v => sectionOf(v) === 'rw')
  const math = all.filter(v => sectionOf(v) === 'math')
  const pause: PauseRange | null = app.settings.pauseFrom && app.settings.pauseTo
    ? { from: app.settings.pauseFrom, to: app.settings.pauseTo } : null
  const st = streak(app.journal, today, pause)
  const mins = minutesToday(app.journal)
  const minsDone = mins >= MIN_MINUTES || st.todayDone
  const daysToExam = Math.max(0, Math.ceil((EXAM_DATE.getTime() - Date.now()) / 86400_000))

  // идеальный день: всё повторено вовремя — зачитывается сам, серия не страдает
  const cAll = homeCounts(all, budget)
  const dueNow = cAll.learnDue + cAll.revDue + cAll.newAvail
  useEffect(() => {
    if (app.ready && app.settings.pat && cAll.total > 0 && dueNow === 0 && !st.todayDone && !st.pausedToday) {
      void creditEmptyDay()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.ready, dueNow, st.todayDone])

  const syncText =
    app.syncStatus === 'syncing' ? 'Синхронизация…'
    : app.syncStatus === 'offline' ? 'Офлайн — изменения сохранены локально'
    : app.syncStatus === 'error' ? `Ошибка синхронизации: ${app.syncError}`
    : app.syncError ? app.syncError
    : app.lastSyncAt ? `Синхронизировано ${new Date(app.lastSyncAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`
    : ''

  const go = (s: Section, reviewOnly = false) => () => startLesson(s, reviewOnly)

  return (
    <div className="screen">
      <FjordScene />
      <div className="appbar">
        <h1 className="brand">SAT SRS</h1>
        <div className="spacer" />
        <span className={`chip chip-streak${st.days === 0 ? ' off' : ''}`}>
          <Flame size={26} off={st.days === 0} />
          {st.days}
          {st.freezes > 0 && <span className="freeze">❄{st.freezes}</span>}
        </span>
        <button className="iconbtn" onClick={() => setScreen('stats')} aria-label="Статистика"><Chart /></button>
        <button className="iconbtn" onClick={() => setScreen('settings')} aria-label="Настройки"><Gear /></button>
      </div>

      <div className="fjord-gap">
        <div className="home-buddy"><FlameBuddy size={82} mood={st.todayDone ? 'happy' : 'idle'} /></div>
      </div>

      <div className="card hero hero-slim">
        <div className="hero-head" style={{ marginBottom: 10 }}>
          <span className="hero-title">Сегодня</span>
          <span className="hero-sub">до SAT: {daysToExam} дн <span className="rsep">·</span> завтра: {cAll.revTomorrow}</span>
        </div>
        <div className="minbar-row" style={{ marginTop: 0 }}>
          <div className="minbar"><div style={{ width: `${Math.min(100, (mins / MIN_MINUTES) * 100)}%` }} /></div>
          <span className={`minbar-label${minsDone ? ' done' : ''}`}>
            {st.pausedToday ? `пауза до ${app.settings.pauseTo.slice(5).split('-').reverse().join('.')}` : st.todayDone ? 'день зачтён' : `${Math.floor(mins)}/${MIN_MINUTES} мин`}
          </span>
        </div>
        {st.freezeSpentYesterday && <div className="freeze-note">❄ Заморозка спасла серию — осталось {st.freezes}</div>}
      </div>

      <SectionBlock title="Слова и правила" icon={<Bolt size={18} />} badge="badge-blue" glyph="var(--rune-ansuz)" cards={rw} budget={budget} onStart={go('rw')} onReview={go('rw', true)} />
      <SectionBlock title="Математика" icon={<span className="sec-x">∑</span>} badge="badge-purple" glyph="var(--rune-tiwaz)" cards={math} budget={budget} onStart={go('math')} onReview={go('math', true)} />

      <div className="home-actions">
        <div className="row">
          <button className="btn btn-white" onClick={() => setScreen('add')}><Plus size={18} /> Слово</button>
          <button className="btn btn-white" onClick={() => void startSync()}>Синк</button>
        </div>
      </div>

      <div className={`syncline${app.syncStatus === 'error' ? ' err' : ''}`}>{syncText}</div>
      {(() => {
        const n = unsyncedCount()
        if (n > 0 && app.syncStatus !== 'syncing' && app.syncStatus !== 'ok') {
          return <div className="syncline err">⚠ {n} изменений не синхронизировано — они в безопасности локально</div>
        }
        const exp = app.tokenExpiresAt ? new Date(app.tokenExpiresAt).getTime() : null
        if (exp && exp - Date.now() < 7 * 86400_000) {
          return <div className="syncline err">⚠ Токен GitHub истекает {app.tokenExpiresAt!.slice(0, 10)} — создайте новый заранее</div>
        }
        return null
      })()}
    </div>
  )
}
