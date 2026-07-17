import { useEffect, useMemo, useRef, useState } from 'react'
import { Rating, State, type Grade } from 'ts-fsrs'
import { useApp, views, rateItem, finishSession, setScreen, startSync, currentJournal, setCause, markIntroduced } from '../lib/store'
import type { CardView } from '../lib/types'
import {
  buildQueue, makeScheduler, intervalLabel, shouldRequeue, requeuePosition, GRADES,
  pickFormat, mcDistractors, prepOptions, checkTyped, checkNumeric, suggestedGrade, sectionOf, itemKey, effectiveRetention
} from '../lib/scheduler'
import Tex from '../components/Tex'
import { newIntroducedOn, minutesToday, MIN_MINUTES, cardTimeCap } from '../lib/journal'
import { dayKey } from '../lib/daytime'
import type { Format, SessionResult, StudyItem } from '../lib/types'
import { Close, Sprout, Timer, Speaker, Flame } from '../components/Icon'
import FlameBuddy from '../components/FlameBuddy'
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

/** Предложение с пропуском / с подставленным словом; $...$ рендерится KaTeX-ом; длинный текст — мельче */
function Sentence({ context, word, revealed }: { context: string; word: string; revealed: boolean }) {
  const parts = context.split(/_{3,}/)
  const cls = `rev-sentence${context.length > 140 ? ' long' : ''}`
  if (parts.length === 1) return <div className={cls}><Tex text={context} /></div>
  return (
    <div className={cls}>
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

const lastCtxIdx = new Map<string, number>()

/** Ротация контекстов round-robin: каждый показ — следующее предложение, полный цикл до повтора */
function pickContext(view: CardView): string {
  const pool = view.contexts.length ? view.contexts : [view.context]
  const idx = ((lastCtxIdx.get(view.path) ?? -1) + 1) % pool.length
  lastCtxIdx.set(view.path, idx)
  return pool[idx]
}

function makeTask(item: StudyItem, deck: ReturnType<typeof views>, introduced?: Set<string>): Task {
  const format = pickFormat(item, deck.map(r => r), introduced)
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
  // прогнозные интервалы на кнопках — тем же retention, что и реальная запись (включая предэкзаменационный рамп)
  const scheduler = useMemo(() => makeScheduler(effectiveRetention(app.settings.requestRetention)), [app.settings.requestRetention])
  const section = app.sessionSection
  const deck = views().filter(v => sectionOf(v) === section)

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
      setQueue(buildQueue(views().filter(v => sectionOf(v) === section), budget))
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
  const [combo, setCombo] = useState(0)
  const [causeFor, setCauseFor] = useState<string | null>(null)
  const [needConfirm, setNeedConfirm] = useState<Grade | null>(null)
  const pendingAdvance = useRef<{ next: StudyItem; atFront: boolean } | null>(null)
  // слова, уже показанные интро в этой сессии: их New-показы дальше — отработка, не интро
  const introduced = useRef(new Set<string>())
  const answeredMs = useRef(0)
  // зачётные секунды: тот же кап на карточку, что и в журнале — таймер согласован с минутами дня
  const creditedSec = useRef(0)
  // минуты, уже сделанные сегодня ДО этой сессии — таймер минимума общедневной, не сессионный
  const baseSec = useMemo(() => Math.floor(minutesToday(currentJournal()) * 60), [])
  const res = useRef<SessionResult>({ day: dayKey(), reviews: 0, newSeen: 0, again: 0, passRev: 0, totalRev: 0, durMs: 0, queueEmpty: false })
  const shownAt = useRef(Date.now())
  const busy = useRef(false)
  const finished = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const head = queue?.[0] ?? null
  // задание пересобирается при смене головы очереди
  useEffect(() => {
    if (!head) { setTask(null); return }
    setTask(makeTask(head, deck, introduced.current))
    setRevealed(false)
    setPicked(null)
    setTyped('')
    setVerdict(null)
    setNeedConfirm(null)
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

  const suggested = task && verdict !== null
    ? suggestedGrade(task.format, verdict === 'correct', verdict === 'typo', answeredMs.current, task.item.view.kind)
    : null

  async function finish(queueEmpty: boolean) {
    if (finished.current) return // двойной тап ✕ / финиш после финиша не пишет дубль session-строки
    finished.current = true
    res.current.durMs = activeSec * 1000
    res.current.queueEmpty = queueEmpty
    await finishSession(res.current)
  }

  function advance(next: StudyItem | null, atFront = false, insertAt?: number) {
    const rest = (queue ?? []).slice(1)
    if (next && insertAt !== undefined) {
      rest.splice(Math.min(rest.length, insertAt), 0, next)
    } else if (next && atFront) {
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
    answeredMs.current = Date.now() - shownAt.current
    setPicked(value)
    setVerdict(ok as 'correct' | 'typo' | 'wrong')
    setRevealed(true)
  }

  async function grade(g: Grade) {
    if (!task || busy.current || finished.current) return
    // мягкое подтверждение: Good/Easy поверх объективно неверного ответа — второй тап тем же
    if (verdict === 'wrong' && g >= Rating.Good && needConfirm !== g) {
      setNeedConfirm(g)
      return
    }
    busy.current = true
    try {
      const elapsed = Date.now() - shownAt.current

      // интро — знакомство, не вспоминание: FSRS не трогаем; отработка через пару карточек
      if (task.format === 'intro' && g !== Rating.Easy) {
        introduced.current.add(itemKey(task.item))
        await markIntroduced(task.item)
        advance(task.item, false, 2)
        return
      }

      const prevState = task.item.fsrs.state
      let rated
      try {
        rated = await rateItem(task.item, g, elapsed, task.format, verdict === null ? undefined : verdict !== 'wrong')
      } catch {
        // карточка исчезла (синк удалил/тьютор переименовал) — пропускаем, не блокируя сессию
        advance(null)
        return
      }

      creditedSec.current += Math.min(elapsed, cardTimeCap(task.item.view.kind)) / 1000

      // комбо верных подряд — чистый session-делайт, на FSRS не влияет
      const passed = verdict !== null ? verdict !== 'wrong' : g > Rating.Again
      setCombo(c => (passed ? c + 1 : 0))

      const r = res.current
      r.reviews++
      if (prevState === State.New) r.newSeen++
      if (g === Rating.Again) r.again++
      if (prevState === State.Review) {
        r.totalRev++
        if (g > Rating.Again) r.passRev++
      }

      // причина ошибки — только для зрелых (Review) карточек: провал на learning = «ещё не выучил»
      const wrong = verdict === 'wrong' || (verdict === null && g === Rating.Again && task.format !== 'intro')
      if (wrong && prevState === State.Review) {
        pendingAdvance.current = { next: { ...task.item, fsrs: rated.card }, atFront: false }
        setCauseFor(rated.lineId)
      } else {
        advance({ ...task.item, fsrs: rated.card })
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
        <div className="rev-body" style={{ textAlign: 'center', alignItems: 'center', justifyContent: 'center' }}>
          <FlameBuddy size={56} mood="idle" />
          <div className="sync-wait">Синхронизация…</div>
        </div>
      </div>
    )
  }
  if (!head || !task) {
    // НЕ .sum-wrap — иначе сработает конфетти из :has(.sum-wrap)
    return (
      <div className="screen">
        <div className="rev-body" style={{ textAlign: 'center', alignItems: 'center', justifyContent: 'center' }}>
          <div className="sum-art"><FlameBuddy size={88} mood="happy" /></div>
          <h2 className="sum-title">Очередь пуста</h2>
          <div className="sum-sub">На сегодня всё повторено — карточки вернутся по графику</div>
          <button className="btn btn-green btn-lg" style={{ maxWidth: 320 }} onClick={() => setScreen('home')}>Домой</button>
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

  // зачётное время: база дня + закрытые карточки (с капом) + текущая карточка (с капом)
  const currentCardSec = Math.min(Date.now() - shownAt.current, cardTimeCap(card.kind)) / 1000
  const minLeft = Math.max(0, Math.round(MIN_MINUTES * 60 - baseSec - creditedSec.current - currentCardSec))
  const mm = String(Math.floor(minLeft / 60)).padStart(2, '0')
  const ss = String(minLeft % 60).padStart(2, '0')

  return (
    <div className={`screen rev-wash wash-${section}`}>
      <div className="rev-top" style={{ position: 'relative' }}>
        <button className="rev-close" onClick={() => { if (!busy.current) void finish(false) }} aria-label="Завершить"><Close /></button>
        <div className="progress"><div style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
        <div className={`combo${combo >= 3 ? ' on' : ''}`}><Flame size={13} /> ×{combo}</div>
        <div className={`rev-timer${minLeft === 0 ? ' done' : ''}`}><Timer size={15} />{minLeft === 0 ? '✓' : `${mm}:${ss}`}</div>
      </div>

      <div className="rev-body" key={done}>
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
        {!revealed && task.format === 'type' && (
          // ввод ПОД предложением: при открытии клавиатуры iOS держит их в кадре вместе
          <input
            ref={inputRef}
            className="type-input"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onFocus={e => e.currentTarget.scrollIntoView({ block: 'nearest' })}
            placeholder={isNumeric ? 'Ваш ответ…' : 'Введите слово…'}
            inputMode={isNumeric ? 'decimal' : 'text'}
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        )}
          </>
        )}

        {!isIntro && revealed && (
          <div className="rev-answer">
            {verdict && (
              <div className={`verdict verdict-${verdict} verdict-row`}>
                <FlameBuddy size={34} mood={verdict === 'correct' ? 'happy' : verdict === 'typo' ? 'idle' : 'sad'} />
                <span>
                  {verdict === 'correct' ? (combo >= 3 ? `Верно! Серия ×${combo + 1}` : 'Верно!')
                    : verdict === 'typo' ? `Почти — опечатка: вы ввели «${typed.trim()}»`
                    : isPrep ? `Правильно: ${card.word} ${card.prep}`
                    : isNumeric ? <>Мимо — ответ: <Tex text={task.answer} /></>
                    : task.format === 'type' ? <>Мимо — вы ввели «{typed.trim()}»</>
                    : 'Мимо'}
                </span>
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
            {card.leech && <div className="leech-note">Пиявка — слово сопротивляется: тьютор переформулирует карточку</div>}
            {!isPrep && card.roots && <div className="rev-roots"><Sprout size={16} /> {card.roots}</div>}
          </div>
        )}
      </div>

      <div className={`rev-bottom${revealed && verdict ? (verdict === 'wrong' ? ' is-wrong' : verdict === 'typo' ? ' is-typo' : ' is-right') : ''}`}>
        {causeFor ? (
          <div className="cause-wrap">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}><FlameBuddy size={50} mood="think" /></div>
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
            <button className="btn btn-green" onClick={() => submitObjective(typed)} disabled={!typed.trim()}>
              Проверить
            </button>
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
              {needConfirm
                ? <span className="confirm-warn">Ответ был неверный — нажмите ещё раз для подтверждения</span>
                : suggested
                ? <span className="kb-only">Enter — подтвердить · 1–4 — своя оценка</span>
                : <>Оценка решает, когда слово вернётся<span className="kb-only"> · клавиши 1–4</span></>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
