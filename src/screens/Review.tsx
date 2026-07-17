import { useEffect, useMemo, useRef, useState } from 'react'
import { Rating, State, type Grade } from 'ts-fsrs'
import { useApp, views, rateItem, finishSession, setScreen, startSync, currentJournal, setCause } from '../lib/store'
import type { CardView } from '../lib/types'
import {
  buildQueue, makeScheduler, intervalLabel, shouldRequeue, requeuePosition, GRADES,
  pickFormat, mcDistractors, prepOptions, checkTyped, checkNumeric, suggestedGrade
} from '../lib/scheduler'
import Tex from '../components/Tex'
import { newIntroducedOn } from '../lib/journal'
import { dayKey } from '../lib/daytime'
import type { Format, SessionResult, StudyItem } from '../lib/types'
import { Close, Sprout, Timer, Speaker } from '../components/Icon'
import { speak, canSpeak } from '../lib/speech'

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

/** Предложение с пропуском / с подставленным словом; $...$ рендерится KaTeX-ом */
function Sentence({ context, word, revealed }: { context: string; word: string; revealed: boolean }) {
  const parts = context.split(/_{3,}/)
  if (parts.length === 1) return <div className="rev-sentence"><Tex text={context} /></div>
  return (
    <div className="rev-sentence">
      {parts.map((p, i) => (
        <span key={i}>
          <Tex text={p} />
          {i < parts.length - 1 &&
            (revealed ? <span className="rev-filled"><Tex text={word} /></span> : <span className="rev-blank">&nbsp;</span>)}
        </span>
      ))}
    </div>
  )
}

/** Задание текущего показа: формат, варианты и контекст фиксируются в момент показа карточки */
interface Task {
  item: StudyItem
  format: Format
  options: string[] // mc/prep
  answer: string    // слово, предлог или авторский вариант
  ctx: string       // выбранный контекст (ротация)
}

const lastCtx = new Map<string, string>()

/** Ротация контекстов: случайный, но не тот же, что в прошлый показ */
function pickContext(view: CardView): string {
  const pool = view.contexts.length ? view.contexts : [view.context]
  let c = pool[Math.floor(Math.random() * pool.length)]
  if (pool.length > 1 && c === lastCtx.get(view.path)) {
    c = pool[(pool.indexOf(c) + 1) % pool.length]
  }
  lastCtx.set(view.path, c)
  return c
}

function makeTask(item: StudyItem, deck: ReturnType<typeof views>): Task {
  const format = pickFormat(item, deck.map(r => r))
  const ctx = format === 'prep' ? item.view.prepContext : pickContext(item.view)
  if (format === 'mc') {
    // авторские варианты (error/grammar) приоритетнее дистракторов из колоды
    if (item.view.choices.length >= 2) {
      const answer = item.view.answerText || item.view.choices[0]
      return { item, format, options: shuffleOnce(item.view.choices), answer, ctx }
    }
    return { item, format, options: shuffleOnce([item.view.word, ...mcDistractors(item.view, deck)]), answer: item.view.word, ctx }
  }
  if (format === 'prep') {
    return { item, format, options: prepOptions(item.view.prep), answer: item.view.prep, ctx }
  }
  if (format === 'type' && item.view.answerNum) {
    return { item, format, options: [], answer: item.view.answerNum, ctx }
  }
  return { item, format, options: [], answer: item.view.word, ctx }
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

  // очередь строится ПОСЛЕ синка на старте урока (свежие карточки тьютора попадают
  // в эту же сессию); офлайн или медленная сеть не блокируют — таймаут 3.5 c
  const [queue, setQueue] = useState<StudyItem[] | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      if (app.settings.pat && navigator.onLine) {
        await Promise.race([startSync(), new Promise(r => setTimeout(r, 3500))])
      }
      if (!alive) return
      // новых за урок — не больше newPerLesson (и не больше остатка дневного лимита)
      const dayLeft = Math.max(0, app.settings.newPerDay - newIntroducedOn(currentJournal(), dayKey()))
      const budget = Math.min(dayLeft, app.settings.newPerLesson || 4)
      setQueue(buildQueue(views(), budget))
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [task, setTask] = useState<Task | null>(() => null)
  const [revealed, setRevealed] = useState(false)
  const [picked, setPicked] = useState<string | null>(null) // выбранный вариант mc/prep
  const [typed, setTyped] = useState('')
  const [verdict, setVerdict] = useState<'correct' | 'typo' | 'wrong' | null>(null)
  const [done, setDone] = useState(0)
  const [activeSec, setActiveSec] = useState(0)
  const [causeFor, setCauseFor] = useState<string | null>(null)
  const pendingAdvance = useRef<{ next: StudyItem; atFront: boolean } | null>(null)
  const res = useRef<SessionResult>({ day: dayKey(), reviews: 0, newSeen: 0, again: 0, passRev: 0, totalRev: 0, durMs: 0, queueEmpty: false })
  const shownAt = useRef(Date.now())
  const busy = useRef(false)
  const finished = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const head = queue?.[0] ?? null
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

  const total = done + (queue?.length ?? 0)

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

  function advance(next: StudyItem | null, atFront = false) {
    const rest = (queue ?? []).slice(1)
    if (next && atFront) {
      // после знакомства слово отрабатывается СРАЗУ, следующим экраном
      rest.splice(0, 0, next)
    } else if (next && shouldRequeue(next.fsrs, new Date())) {
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

  async function pickCauseAndGo(c: string | null) {
    if (causeFor && c) await setCause(causeFor, c)
    setCauseFor(null)
    const p = pendingAdvance.current
    pendingAdvance.current = null
    if (p) advance(p.next, p.atFront)
  }

  /** Ответ в объективных форматах: фиксируем результат и открываем ответ с предложенной оценкой */
  function submitObjective(value: string) {
    if (!task || revealed) return
    const ok = task.format === 'type'
      ? (task.item.view.answerNum ? checkNumeric(value, task.answer) : checkTyped(value, task.answer))
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
      let rated
      try {
        rated = await rateItem(task.item, g, elapsed, task.format, verdict === null ? undefined : verdict !== 'wrong')
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

      // «Продолжить» на интро → немедленная отработка; «Уже знаю» (Easy) — слово уезжает по графику
      const drillNow = task.format === 'intro' && g !== Rating.Easy
      const wrong = verdict === 'wrong' || (verdict === null && g === Rating.Again && task.format !== 'intro')
      if (wrong) {
        // один тап: почему ошибка? — уходит в журнал и Карту пробелов тьютора
        pendingAdvance.current = { next: { ...task.item, fsrs: rated.card }, atFront: drillNow }
        setCauseFor(rated.lineId)
      } else {
        advance({ ...task.item, fsrs: rated.card }, drillNow)
      }
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

  if (!queue || (head && !task)) {
    return (
      <div className="screen">
        <div className="rev-body" style={{ textAlign: 'center', alignItems: 'center' }}>
          <div className="sync-wait">Синхронизация…</div>
        </div>
      </div>
    )
  }
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
  const sentence = task.ctx
  const answerWord = isPrep ? card.prep : task.format === 'mc' && card.choices.length >= 2 ? task.answer : card.word
  const isNumeric = !!card.answerNum
  const isAuthored = card.choices.length >= 2
  const taskHint =
    task.format === 'mc' ? (isAuthored ? 'Выберите правильный вариант' : 'Какое слово подходит в пропуск?')
    : task.format === 'prep' ? 'Какой предлог здесь правильный?'
    : task.format === 'type' ? (isNumeric ? 'Решите и введите ответ' : 'Впишите слово, подходящее в пропуск')
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
              {card.kind === 'vocab' && canSpeak() ? (
                <button className="speak-word intro-word" onClick={() => speak(card.word)} aria-label="Произнести">
                  {card.word}<span className="speak-ic"><Speaker /></span><span className="pos">{card.pos}</span>
                </button>
              ) : (
                <div className="intro-word">{card.word}<span className="pos">{card.pos}</span></div>
              )}
              {card.meaning_en && <div className="rev-meaning-en">{card.meaning_en}</div>}
              {card.meaning_ru && <div className="rev-meaning-ru">{card.meaning_ru}</div>}
              {card.roots && <div className="rev-roots"><Sprout size={16} /> {card.roots}</div>}
              <div className="intro-label">Пример использования</div>
              <Sentence context={task.ctx} word={card.word} revealed />
            </div>
          </>
        ) : (
          <>
        <span className={`pill ${FORMAT_HINT[task.format].cls}`}>
          {isAuthored || isNumeric ? (card.domain || 'Задание') : FORMAT_HINT[task.format].text}
          {isPrep && <> · {card.word}</>}
          {card.desmos && <> · Desmos</>}
        </span>
        <Sentence context={sentence} word={answerWord} revealed={revealed} />
        {!revealed && <div className="rev-task">{taskHint}</div>}
          </>
        )}

        {!isIntro && revealed && (
          <div className="rev-answer">
            {verdict && (
              <div className={`verdict verdict-${verdict}`}>
                {verdict === 'correct' ? 'Верно!'
                  : verdict === 'typo' ? `Почти — опечатка: вы ввели «${typed.trim()}»`
                  : isPrep ? `Правильно: ${card.word} ${card.prep}`
                  : isNumeric ? <>Мимо — ответ: <Tex text={task.answer} /></>
                  : 'Мимо'}
              </div>
            )}
            {card.kind === 'vocab' && canSpeak() ? (
              <button className="speak-word rev-word" onClick={() => speak(isPrep ? `${card.word} ${card.prep}` : card.word)} aria-label="Произнести">
                {isPrep ? `${card.word} ${card.prep}` : card.word}<span className="speak-ic"><Speaker size={19} /></span><span className="pos">{card.pos}</span>
              </button>
            ) : (
              <div className="rev-word">{isPrep ? `${card.word} ${card.prep}` : card.word}<span className="pos">{card.pos}</span></div>
            )}
            {!isPrep && isNumeric && verdict === 'correct' && <div className="rev-meaning-ru">Ответ: <Tex text={task.answer} /></div>}
            {!isPrep && card.meaning_en && <div className="rev-meaning-en">{card.meaning_en}</div>}
            {!isPrep && card.meaning_ru && <div className="rev-meaning-ru">{card.meaning_ru}</div>}
            {!isPrep && card.explain && <div className="rev-explain"><Tex text={card.explain} /></div>}
            {!isPrep && card.roots && <div className="rev-roots"><Sprout size={16} /> {card.roots}</div>}
          </div>
        )}
      </div>

      <div className={`rev-bottom${revealed && verdict ? (verdict === 'wrong' ? ' is-wrong' : ' is-right') : ''}`}>
        {causeFor ? (
          <div className="cause-wrap">
            <div className="cause-title">Почему ошибка?</div>
            <div className="cause-grid">
              {['правило', 'слово', 'misread', 'логика', 'тайминг'].map(c => (
                <button key={c} className="btn btn-white cause-btn" onClick={() => void pickCauseAndGo(c)}>{c}</button>
              ))}
            </div>
            <button className="intro-know" onClick={() => void pickCauseAndGo(null)}>Пропустить</button>
          </div>
        ) : isIntro ? (
          <>
            <button className="btn btn-green btn-lg" onClick={() => void grade(Rating.Good)}>Продолжить</button>
            <button className="intro-know" onClick={() => void grade(Rating.Easy)}>Уже знаю это слово</button>
          </>
        ) : !revealed ? (
          task.format === 'reveal' ? (
            <>
              <button className="btn btn-green" onClick={() => setRevealed(true)}>Показать ответ</button>
              <div className="hint-keys kb-only">Space — показать</div>
            </>
          ) : task.format === 'type' ? (
            <>
              <input
                ref={inputRef}
                className="type-input"
                value={typed}
                onChange={e => setTyped(e.target.value)}
                placeholder={isNumeric ? 'Ваш ответ…' : 'Введите слово…'}
                inputMode={isNumeric ? 'decimal' : 'text'}
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
                <button key={o} className="mc-option" onClick={() => submitObjective(o)}><Tex text={o} /></button>
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
                        <Tex text={o} />
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
              {suggested
                ? <span className="kb-only">Enter — подтвердить · 1–4 — своя оценка</span>
                : <>Оценка решает, когда слово вернётся<span className="kb-only"> · клавиши 1–4</span></>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
