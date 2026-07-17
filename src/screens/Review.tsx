import { useEffect, useMemo, useRef, useState } from 'react'
import { Rating, State, type Grade } from 'ts-fsrs'
import { useApp, views, rateCard, finishSession, setScreen } from '../lib/store'
import { buildQueue, makeScheduler, intervalLabel, shouldRequeue, requeuePosition, GRADES } from '../lib/scheduler'
import { newIntroducedOn, MIN_MINUTES } from '../lib/journal'
import { dayKey } from '../lib/daytime'
import type { CardView, SessionResult } from '../lib/types'

const GRADE_CLASS: Record<number, string> = {
  [Rating.Again]: 'btn-red',
  [Rating.Hard]: 'btn-yellow',
  [Rating.Good]: 'btn-green',
  [Rating.Easy]: 'btn-blue'
}

/** Предложение с пропуском / с подставленным словом */
function Sentence({ context, word, revealed }: { context: string; word: string; revealed: boolean }) {
  const parts = context.split(/_{3,}/)
  if (parts.length === 1) {
    return <div className="rev-sentence">{context}</div>
  }
  return (
    <div className="rev-sentence">
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 &&
            (revealed ? <span className="rev-filled">{word}</span> : <span className="rev-blank">&nbsp;</span>)}
        </span>
      ))}
    </div>
  )
}

export default function Review() {
  const app = useApp()
  const scheduler = useMemo(() => makeScheduler(app.settings.requestRetention), [app.settings.requestRetention])

  const [queue, setQueue] = useState<CardView[]>(() => {
    const budget = Math.max(0, app.settings.newPerDay - newIntroducedOn(app.journal, dayKey()))
    return buildQueue(views(), budget)
  })
  const [revealed, setRevealed] = useState(false)
  const [done, setDone] = useState(0)
  const [activeSec, setActiveSec] = useState(0)
  const res = useRef<SessionResult>({ day: dayKey(), reviews: 0, newSeen: 0, again: 0, passRev: 0, totalRev: 0, durMs: 0, queueEmpty: false })
  const shownAt = useRef(Date.now())
  const busy = useRef(false)
  const finished = useRef(false)

  const card = queue[0] ?? null
  const total = done + queue.length

  // таймер активного времени (пауза при сворачивании)
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') setActiveSec(s => s + 1)
    }, 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    shownAt.current = Date.now()
  }, [card?.path, done])

  async function finish(queueEmpty: boolean) {
    if (finished.current) return // двойной тап ✕ / финиш после финиша не пишет дубль session-строки
    finished.current = true
    res.current.durMs = activeSec * 1000
    res.current.queueEmpty = queueEmpty
    await finishSession(res.current)
  }

  function advance(next: CardView | null) {
    const rest = queue.slice(1)
    if (next && shouldRequeue(next.fsrs, new Date())) {
      rest.splice(requeuePosition(rest.length, next.fsrs, new Date()), 0, next)
    }
    setRevealed(false)
    setDone(d => d + 1)
    if (rest.length === 0) {
      setQueue([])
      void finish(true)
    } else {
      setQueue(rest)
    }
  }

  async function grade(g: Grade) {
    if (!card || busy.current || finished.current) return
    busy.current = true
    try {
      const elapsed = Date.now() - shownAt.current
      const prevState = card.fsrs.state
      let next
      try {
        next = await rateCard(card, g, elapsed)
      } catch {
        // карточка исчезла (синк удалил/тьютор переименовал) — пропускаем, не блокируя сессию
        advance(null)
        return
      }

      const r = res.current
      r.reviews++
      if (prevState === State.New) r.newSeen++
      if (g === Rating.Again) r.again++
      if (prevState === State.Review) {
        r.totalRev++
        if (g > Rating.Again) r.passRev++
      }

      advance({ ...card, fsrs: next })
    } finally {
      busy.current = false
    }
  }

  // клавиатура: Space/Enter — показать, 1–4 — оценка
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault()
        if (!revealed) setRevealed(true)
      } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault()
        void grade(GRADES[Number(e.key) - 1].rating)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!card) {
    return (
      <div className="screen">
        <div className="rev-body" style={{ textAlign: 'center' }}>
          <div>Очередь пуста ✓</div>
          <button className="btn btn-green" onClick={() => setScreen('home')}>Домой</button>
        </div>
      </div>
    )
  }

  const minLeft = Math.max(0, MIN_MINUTES * 60 - activeSec)
  const mm = String(Math.floor(minLeft / 60)).padStart(2, '0')
  const ss = String(minLeft % 60).padStart(2, '0')

  return (
    <div className="screen">
      <div className="rev-top">
        <button className="rev-close" onClick={() => { if (!busy.current) void finish(false) }} aria-label="Завершить">✕</button>
        <div className="progress"><div style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
        <div className={`rev-timer${minLeft === 0 ? ' done' : ''}`}>{minLeft === 0 ? '✓' : `${mm}:${ss}`}</div>
      </div>

      <div className="rev-body">
        <div className="rev-source">{card.fsrs.state === State.New ? 'Новое слово' : 'Вспомни слово'} · {card.source}</div>
        <Sentence context={card.context} word={card.word} revealed={revealed} />
        {revealed && (
          <div className="rev-answer">
            <div className="rev-word">{card.word}<span className="pos">{card.pos}</span></div>
            {card.meaning_en && <div className="rev-meaning-en">{card.meaning_en}</div>}
            {card.meaning_ru && <div className="rev-meaning-ru">{card.meaning_ru}</div>}
            {card.roots && <div className="rev-roots">🌱 {card.roots}</div>}
          </div>
        )}
      </div>

      <div className="rev-bottom">
        {!revealed ? (
          <>
            <button className="btn btn-green" onClick={() => setRevealed(true)}>Показать ответ</button>
            <div className="hint-keys">Space — показать</div>
          </>
        ) : (
          <>
            <div className="grades">
              {GRADES.map(g => (
                <button key={g.key} className={`btn grade-btn ${GRADE_CLASS[g.rating]}`} onClick={() => void grade(g.rating)}>
                  {g.label}
                  <span className="iv">{intervalLabel(scheduler, card.fsrs, g.rating, new Date())}</span>
                </button>
              ))}
            </div>
            <div className="hint-keys">1 · 2 · 3 · 4</div>
          </>
        )}
      </div>
    </div>
  )
}
