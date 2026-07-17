import { useEffect, useMemo, useRef, useState } from 'react'
import { Rating, State, type Grade } from 'ts-fsrs'
import { useApp, views, rateItem, finishSession, setScreen } from '../lib/store'
import {
  buildQueue, makeScheduler, intervalLabel, shouldRequeue, requeuePosition, GRADES,
  pickFormat, mcDistractors, prepOptions, checkTyped, suggestedGrade
} from '../lib/scheduler'
import { newIntroducedOn } from '../lib/journal'
import { dayKey } from '../lib/daytime'
import type { Format, SessionResult, StudyItem } from '../lib/types'
import { Close, Sprout, Timer } from '../components/Icon'

const GRADE_CLASS: Record<number, string> = {
  [Rating.Again]: 'btn-red',
  [Rating.Hard]: 'btn-yellow',
  [Rating.Good]: 'btn-green',
  [Rating.Easy]: 'btn-blue'
}

function shuffleOnce<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Предложение с пропуском / с подставленным словом */
function Sentence({ context, word, revealed }: { context: string; word: string; revealed: boolean }) {
  const parts = context.split(/_{3,}/)
  if (parts.length === 1) return <div className="rev-sentence">{context}</div>
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

/** Задание текущего показа: формат и варианты фиксируются в момент показа карточки */
interface Task {
  item: StudyItem
  format: Format
  options: string[] // mc/prep
  answer: string    // слово или предлог
}

function makeTask(item: StudyItem, deck: ReturnType<typeof views>): Task {
  const format = pickFormat(item, deck.map(r => r))
  if (format === 'mc') {
    return { item, format, options: shuffleOnce([item.view.word, ...mcDistractors(item.view, deck)]), answer: item.view.word }
  }
  if (format === 'prep') {
    return { item, format, options: prepOptions(item.view.prep), answer: item.view.prep }
  }
  return { item, format, options: [], answer: item.view.word }
}

const FORMAT_HINT: Record<Format, { text: string; cls: string }> = {
  intro: { text: 'Новое слово', cls: 'pill-green' },
  reveal: { text: 'Вспомни слово', cls: 'pill-blue' },
  mc: { text: 'Выбери слово', cls: 'pill-blue' },
  type: { text: 'Впиши слово', cls: 'pill-purple' },
  prep: { text: 'Выбери предлог', cls: 'pill-yellow' }
}

export default function Review() {
  const app = useApp()
  const scheduler = useMemo(() => makeScheduler(app.settings.requestRetention), [app.settings.requestRetention])
  const deck = views()

  const [queue, setQueue] = useState<StudyItem[]>(() => {
    const budget = Math.max(0, app.settings.newPerDay - newIntroducedOn(app.journal, dayKey()))
    return buildQueue(views(), budget)
  })
  const [task, setTask] = useState<Task | null>(() => null)
  const [revealed, setRevealed] = useState(false)
  const [picked, setPicked] = useState<string | null>(null) // выбранный вариант mc/prep
  const [typed, setTyped] = useState('')
  const [verdict, setVerdict] = useState<'correct' | 'typo' | 'wrong' | null>(null)
  const [done, setDone] = useState(0)
  const [activeSec, setActiveSec] = useState(0)
  const res = useRef<SessionResult>({ day: dayKey(), reviews: 0, newSeen: 0, again: 0, passRev: 0, totalRev: 0, durMs: 0, queueEmpty: false })
  const shownAt = useRef(Date.now())
  const busy = useRef(false)
  const finished = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const head = queue[0] ?? null
  // задание пересобирается при смене головы очереди
  useEffect(() => {
    if (!head) { setTask(null); return }
    setTask(makeTask(head, deck))
    setRevealed(false)
    setPicked(null)
    setTyped('')
    setVerdict(null)
    shownAt.current = Date.now()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head && `${head.view.path}#${head.skill}#${done}`])

  const total = done + queue.length

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') setActiveSec(s => s + 1)
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const suggested = task && verdict !== null ? suggestedGrade(task.format, verdict === 'correct', verdict === 'typo') : null

  async function finish(queueEmpty: boolean) {
    if (finished.current) return // двойной тап ✕ / финиш после финиша не пишет дубль session-строки
    finished.current = true
    res.current.durMs = activeSec * 1000
    res.current.queueEmpty = queueEmpty
    await finishSession(res.current)
  }

  function advance(next: StudyItem | null) {
    const rest = queue.slice(1)
    if (next && shouldRequeue(next.fsrs, new Date())) {
      rest.splice(requeuePosition(rest.length, next.fsrs, new Date()), 0, next)
    }
    setDone(d => d + 1)
    if (rest.length === 0) {
      setQueue([])
      void finish(true)
    } else {
      setQueue(rest)
    }
  }

  /** Ответ в объективных форматах: фиксируем результат и открываем ответ с предложенной оценкой */
  function submitObjective(value: string) {
    if (!task || revealed) return
    const ok = task.format === 'type'
      ? checkTyped(value, task.answer)
      : value.trim().toLowerCase() === task.answer.toLowerCase() ? 'correct' : 'wrong'
    setPicked(value)
    setVerdict(ok as 'correct' | 'typo' | 'wrong')
    setRevealed(true)
  }

  async function grade(g: Grade) {
    if (!task || busy.current || finished.current) return
    busy.current = true
    try {
      const elapsed = Date.now() - shownAt.current
      const prevState = task.item.fsrs.state
      let next
      try {
        next = await rateItem(task.item, g, elapsed, task.format, verdict === null ? undefined : verdict !== 'wrong')
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

      advance({ ...task.item, fsrs: next })
    } finally {
      busy.current = false
    }
  }

  // клавиатура: Space/Enter — показать/подтвердить, 1–4 — оценка
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!task) return
      const typing = document.activeElement === inputRef.current
      if (task.format === 'intro') {
        if ((e.code === 'Space' || e.code === 'Enter') && !typing) {
          e.preventDefault()
          void grade(Rating.Good)
        }
        return
      }
      if (e.code === 'Enter' && typing && !revealed) {
        e.preventDefault()
        submitObjective(typed)
      } else if ((e.code === 'Space' && !typing) || (e.code === 'Enter' && !typing)) {
        e.preventDefault()
        if (!revealed && task.format === 'reveal') setRevealed(true)
        else if (revealed && suggested) void grade(suggested)
      } else if (revealed && !typing && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault()
        void grade(GRADES[Number(e.key) - 1].rating)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!head || !task) {
    return (
      <div className="screen">
        <div className="rev-body" style={{ textAlign: 'center' }}>
          <div>Очередь пуста ✓</div>
          <button className="btn btn-green" onClick={() => setScreen('home')}>Домой</button>
        </div>
      </div>
    )
  }

  const card = task.item.view
  const isPrep = task.format === 'prep'
  const isIntro = task.format === 'intro'
  const sentence = isPrep ? card.prepContext : card.context
  const answerWord = isPrep ? card.prep : card.word
  const taskHint =
    task.format === 'mc' ? 'Какое слово подходит в пропуск?'
    : task.format === 'prep' ? 'Какой предлог здесь правильный?'
    : task.format === 'type' ? 'Впишите слово, подходящее в пропуск'
    : 'Вспомните слово — потом проверьте себя'

  const minLeft = Math.max(0, 15 * 60 - activeSec)
  const mm = String(Math.floor(minLeft / 60)).padStart(2, '0')
  const ss = String(minLeft % 60).padStart(2, '0')

  return (
    <div className="screen">
      <div className="rev-top">
        <button className="rev-close" onClick={() => { if (!busy.current) void finish(false) }} aria-label="Завершить"><Close /></button>
        <div className="progress"><div style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
        <div className={`rev-timer${minLeft === 0 ? ' done' : ''}`}><Timer size={15} />{minLeft === 0 ? '✓' : `${mm}:${ss}`}</div>
      </div>

      <div className="rev-body">
        {isIntro ? (
          <>
            <span className="pill pill-green">Новое слово</span>
            <div className="intro">
              <div className="intro-word">{card.word}<span className="pos">{card.pos}</span></div>
              {card.meaning_en && <div className="rev-meaning-en">{card.meaning_en}</div>}
              {card.meaning_ru && <div className="rev-meaning-ru">{card.meaning_ru}</div>}
              {card.roots && <div className="rev-roots"><Sprout size={16} /> {card.roots}</div>}
              <div className="intro-label">Пример использования</div>
              <Sentence context={card.context} word={card.word} revealed />
            </div>
          </>
        ) : (
          <>
        <span className={`pill ${FORMAT_HINT[task.format].cls}`}>
          {FORMAT_HINT[task.format].text}
          {isPrep && <> · {card.word}</>}
        </span>
        <Sentence context={sentence} word={answerWord} revealed={revealed} />
        {!revealed && <div className="rev-task">{taskHint}</div>}
          </>
        )}

        {!isIntro && revealed && (
          <div className="rev-answer">
            {verdict && (
              <div className={`verdict verdict-${verdict}`}>
                {verdict === 'correct' ? 'Верно!' : verdict === 'typo' ? `Почти — опечатка: вы ввели «${typed.trim()}»` : isPrep ? `Правильно: ${card.word} ${card.prep}` : 'Мимо'}
              </div>
            )}
            <div className="rev-word">{isPrep ? `${card.word} ${card.prep}` : card.word}<span className="pos">{card.pos}</span></div>
            {!isPrep && card.meaning_en && <div className="rev-meaning-en">{card.meaning_en}</div>}
            {!isPrep && card.meaning_ru && <div className="rev-meaning-ru">{card.meaning_ru}</div>}
            {!isPrep && card.roots && <div className="rev-roots"><Sprout size={16} /> {card.roots}</div>}
          </div>
        )}
      </div>

      <div className={`rev-bottom${revealed && verdict ? (verdict === 'wrong' ? ' is-wrong' : ' is-right') : ''}`}>
        {isIntro ? (
          <>
            <button className="btn btn-green btn-lg" onClick={() => void grade(Rating.Good)}>Продолжить</button>
            <button className="intro-know" onClick={() => void grade(Rating.Easy)}>Уже знаю это слово</button>
          </>
        ) : !revealed ? (
          task.format === 'reveal' ? (
            <>
              <button className="btn btn-green" onClick={() => setRevealed(true)}>Показать ответ</button>
              <div className="hint-keys">Space — показать</div>
            </>
          ) : task.format === 'type' ? (
            <>
              <input
                ref={inputRef}
                className="type-input"
                value={typed}
                onChange={e => setTyped(e.target.value)}
                placeholder="Введите слово…"
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <button className="btn btn-green" style={{ marginTop: 10 }} onClick={() => submitObjective(typed)} disabled={!typed.trim()}>
                Проверить
              </button>
            </>
          ) : (
            <div className="mc-stack">
              {task.options.map(o => (
                <button key={o} className="mc-option" onClick={() => submitObjective(o)}>{o}</button>
              ))}
            </div>
          )
        ) : (
          <>
            {(task.format === 'mc' || task.format === 'prep') && (
              <div className="mc-stack answered">
                {task.options
                  .filter(o => o.toLowerCase() === task.answer.toLowerCase() || o === picked)
                  .map(o => {
                    const isAnswer = o.toLowerCase() === task.answer.toLowerCase()
                    return (
                      <button key={o} disabled className={`mc-option ${isAnswer ? 'mc-right' : 'mc-wrong'}`}>
                        {o}
                      </button>
                    )
                  })}
              </div>
            )}
            <div className="grades">
              {GRADES.map(g => (
                <button
                  key={g.key}
                  className={`btn grade-btn ${GRADE_CLASS[g.rating]}${suggested === g.rating ? ' suggested' : ''}`}
                  onClick={() => void grade(g.rating)}
                >
                  {g.label}
                  <span className="iv">{intervalLabel(scheduler, task.item.fsrs, g.rating, new Date())}</span>
                </button>
              ))}
            </div>
            <div className="hint-keys">
              {suggested ? 'Enter — подтвердить · 1–4 — своя оценка' : 'Оценка решает, когда слово вернётся · клавиши 1–4'}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
