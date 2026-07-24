import { useEffect, useMemo, useRef, useState } from 'react'
import { Rating, State, type Grade } from 'ts-fsrs'
import { useApp, views, rateItem, finishSession, setScreen, startSync, currentJournal, setCause, markIntroduced, deferItemToNextDay } from '../lib/store'
import type { CardView } from '../lib/types'
import {
  buildQueue, makeScheduler, intervalLabel, shouldRequeue, requeuePosition, GRADES,
  pickFormat, mcDistractors, prepOptions, checkTyped, checkNumeric, suggestedGrade, sectionOf, itemKey, effectiveRetention, NEW_GAP
} from '../lib/scheduler'
import { pickNextIndex, type OrderCtx } from '../lib/session'
import Tex from '../components/Tex'
import { newIntroducedOn, minutesToday, MIN_MINUTES, cardTimeCap, forcedTodaySlugs } from '../lib/journal'
import { dayKey } from '../lib/daytime'
import type { Format, SessionResult, StudyItem } from '../lib/types'
import { Close, Sprout, Timer, Speaker, Flame } from '../components/Icon'
import FlameBuddy from '../components/FlameBuddy'
import { speak, canSpeak } from '../lib/speech'

const GRADE_CLASS: Record<number, string> = {
  [Rating.Again]: 'grade-again',
  [Rating.Hard]: 'grade-hard',
  [Rating.Good]: 'grade-good',
  [Rating.Easy]: 'grade-easy'
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
  cue: 'sentence' | 'meaning' // по чему вспоминаем: пропуск в предложении или значение
}

/** Сколько раз добирать одно сегодняшнее новое слово за сессию (point 4), прежде чем счесть урок исчерпанным */
const DRILL_PER_SESSION = 2

const lastCtxIdx = new Map<string, number>()

/** Ротация контекстов round-robin: каждый показ — следующее предложение, полный цикл до повтора */
function pickContext(view: CardView): string {
  const pool = view.contexts.length ? view.contexts : [view.context]
  const idx = ((lastCtxIdx.get(view.path) ?? -1) + 1) % pool.length
  lastCtxIdx.set(view.path, idx)
  return pool[idx]
}

function makeTask(item: StudyItem, deck: ReturnType<typeof views>, introduced?: Set<string>, lapsed?: Set<string>, reintroAllowed = true): Task {
  const format = pickFormat(item, deck.map(r => r), introduced, lapsed, reintroAllowed)
  const ctx = format === 'prep' ? item.view.prepContext : pickContext(item.view)
  // если у слова один пример и он уже показан на знакомстве, спрашивать по нему нельзя:
  // это проверка памяти на предложение, а не на слово. Тогда цель — значение.
  const exampleSpent = introduced?.has(itemKey(item)) && item.view.contexts.length < 2
  const cue: Task['cue'] =
    (format === 'reveal' || format === 'type') && exampleSpent && !item.view.answerNum && !!item.view.meaning_ru
      ? 'meaning' : 'sentence'
  const base = { item, format, ctx, cue }
  if (format === 'mc') {
    // авторские варианты (error/grammar) приоритетнее дистракторов из колоды
    if (item.view.choices.length >= 2) {
      const answer = item.view.answerText || item.view.choices[0]
      return { ...base, options: shuffleOnce(item.view.choices), answer }
    }
    return { ...base, options: shuffleOnce([item.view.word, ...mcDistractors(item.view, deck)]), answer: item.view.word }
  }
  if (format === 'prep') {
    return { ...base, options: prepOptions(item.view.prep), answer: item.view.prep }
  }
  if (format === 'type' && item.view.answerNum) {
    return { ...base, options: [], answer: item.view.answerNum }
  }
  return { ...base, options: [], answer: item.view.word }
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
      // новых за урок — не больше newPerLesson (и не больше остатка дневного лимита);
      // режим «только повторение» — ноль новых
      const dayLeft = Math.max(0, app.settings.newPerDay - newIntroducedOn(currentJournal(), dayKey()))
      const budget = app.sessionReviewOnly ? 0 : Math.min(dayLeft, app.settings.newPerLesson || 3)
      // point 3: слова, введённые сегодня в прошлых уроках и ещё не отработанные дважды,
      // принудительно добираются в этот урок (buildQueue дотягивает их из Learning с due на завтра)
      const forced = forcedTodaySlugs(currentJournal(), dayKey())
      setQueue(buildQueue(views().filter(v => sectionOf(v) === section), budget, new Date(), forced))
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
  // слова, только что помеченные «Заново» (не вспомнил): следующий показ — окно-переznakomство «Подзабылось»
  const lapsed = useRef(new Set<string>())
  // окон-знакомств за урок (новые intro + «Подзабылось»): «Подзабылось» для мозга — та же нагрузка,
  // поэтому входит в общий урочный лимит. Новые приоритетны, переznakomство берёт остаток.
  const introShown = useRef(0)
  const introLimit = Math.max(1, app.settings.newPerLesson || 3)
  // сколько отработок прошло с прошлого знакомства (новые слова не идут пачкой)
  const sinceIntro = useRef(NEW_GAP)
  // point 2: время последнего показа каждой единицы — не показываем одну карту чаще, чем раз в минуту
  const shownTimes = useRef(new Map<string, number>())
  // point 4: сколько раз слово отработано в ЭТОЙ сессии — добор сегодняшних новых имеет предел
  const drilled = useRef(new Map<string, number>())
  // A3/A4: слово и «знакомство ли» предыдущего показанного экрана — очередь не ставит два экрана
  // одного слова встык (A3) и не выдаёт два знакомства подряд без упражнения между ними (A4)
  const lastShownPath = useRef<string | null>(null)
  const lastWasIntro = useRef(false)
  // C2: сколько раз слово провалено за ЭТУ сессию (по path) и множество отложенных до завтра (провал ×2)
  const sessionFails = useRef(new Map<string, number>())
  const deferredToday = useRef(new Set<string>())
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
    // новое слово сверх урочного лимита окон-знакомств не вводим (переznakomство уже съело бюджет) —
    // новое нельзя показать упражнением, поэтому откладываем его на следующий урок/день, а не показываем
    const isNewIntro = head.fsrs.state === State.New && !introduced.current.has(itemKey(head))
      && head.view.choices.length < 2 && !head.view.answerNum && head.skill !== 'prep'
    if (isNewIntro && introShown.current >= introLimit) {
      const rest = (queue ?? []).slice(1)
      if (rest.length === 0) {
        const extra = topUp()
        if (extra.length) { setQueue(extra); return }
        setQueue([]); void finish(true)
      } else setQueue(rest)
      return
    }
    const shown = makeTask(head, deck, introduced.current, lapsed.current, introShown.current < introLimit)
    setTask(shown)
    // point 2/A2: отметка момента показа этой единицы — pickNextIndex держит 60-секундный разрыв
    shownTimes.current.set(itemKey(head), Date.now())
    // A3/A4: что показано этим экраном — вход для следующего выбора очереди
    lastShownPath.current = head.view.path
    lastWasIntro.current = shown.format === 'intro'
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

  // в «показе» вердикт появляется, только если пользователь сам ввёл слово —
  // тогда сигнал объективный и оценка считается как у ввода
  const suggested = task && verdict !== null
    ? suggestedGrade(task.format === 'reveal' ? 'type' : task.format, verdict === 'correct', verdict === 'typo', answeredMs.current, task.item.view.kind)
    : null

  async function finish(queueEmpty: boolean) {
    if (finished.current) return // двойной тап ✕ / финиш после финиша не пишет дубль session-строки
    finished.current = true
    res.current.durMs = activeSec * 1000
    res.current.queueEmpty = queueEmpty
    await finishSession(res.current)
  }

  /** Текущий контекст выбора следующего экрана (A2/A3/A4) — снимок refs в момент вызова. */
  function orderCtx(): OrderCtx {
    return {
      deck,
      introduced: introduced.current,
      lapsed: lapsed.current,
      reintroAllowed: introShown.current < introLimit,
      shownTimes: shownTimes.current,
      now: Date.now(),
      lastPath: lastShownPath.current,
      lastWasIntro: lastWasIntro.current,
      sinceIntro: sinceIntro.current
    }
  }

  /**
   * point 4: пустая очередь ≠ конец урока, пока сегодняшние новые слова недоработаны.
   * Добираем recall-единицы слов, введённых сегодня (по журналу), которые в этой сессии
   * показаны меньше DRILL_PER_SESSION раз. Список конечен и убывает (каждый показ учитывается
   * в drilled), поэтому урок гарантированно завершится, когда добирать станет нечего.
   */
  function topUp(): StudyItem[] {
    const forced = forcedTodaySlugs(currentJournal(), dayKey())
    if (!forced.size) return []
    return deck
      .filter(v => forced.has(v.slug) && (v.fsrs.state === State.Learning || v.fsrs.state === State.Relearning))
      .map(v => ({ view: v, skill: 'recall' as const, fsrs: v.fsrs }))
      .filter(i => (drilled.current.get(itemKey(i)) ?? 0) < DRILL_PER_SESSION)
  }

  async function advance(next: StudyItem | null, atFront = false, insertAt?: number) {
    let rest = (queue ?? []).slice(1)
    // C2: слова, дважды проваленные за сессию, из остатка урока убираются совсем
    if (deferredToday.current.size) rest = rest.filter(i => !deferredToday.current.has(i.view.path))
    // возврат оценённой карточки в очередь — но не той, что ушла на завтра (C2)
    if (next && !deferredToday.current.has(next.view.path)) {
      if (insertAt !== undefined) {
        rest.splice(Math.min(rest.length, insertAt), 0, next)
      } else if (atFront) {
        rest.splice(0, 0, next)
      } else if (shouldRequeue(next.fsrs, new Date())) {
        rest.splice(requeuePosition(rest.length, next.fsrs, new Date()), 0, next)
      }
    }
    setDone(d => d + 1)
    // A2/A3/A4: следующий экран — первая допустимая единица; −1 = показывать без нарушения нечего
    let idx = pickNextIndex(rest, orderCtx())
    if (idx < 0) {
      // «карточка ждёт» (A3): добираем сегодняшние недоработанные (point 4) и пробуем снова
      const extra = topUp().filter(i =>
        !deferredToday.current.has(i.view.path) && !rest.some(r => itemKey(r) === itemKey(i)))
      if (extra.length) { rest = [...rest, ...extra]; idx = pickNextIndex(rest, orderCtx()) }
    }
    if (idx < 0) {
      // добирать нечего и всё, что осталось, нарушило бы инвариант — урок закончен (B3)
      setQueue([])
      // point 5: finish дожидается finishSession — строка session пишется ПОСЛЕ того,
      // как await rateItem последней карточки уже занёс её review-строку (иначе итоги занижены)
      await finish(true)
      return
    }
    if (idx > 0) {
      const [pick] = rest.splice(idx, 1)
      rest = [pick, ...rest]
    }
    setQueue(rest)
  }

  async function pickCauseAndGo(c: string | null) {
    if (causeFor && c) await setCause(causeFor, c)
    setCauseFor(null)
    const p = pendingAdvance.current
    pendingAdvance.current = null
    if (p) await advance(p.next, p.atFront)
  }

  /** Ответ в объективных форматах: фиксируем результат и открываем ответ с предложенной оценкой */
  function submitObjective(value: string, byTyping = false) {
    if (!task || revealed) return
    const ok = byTyping || task.format === 'type'
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

      // окно-знакомство показано (новое ИЛИ «Подзабылось») — тратит урочный лимит, флаг провала снят
      if (task.format === 'intro') { introShown.current++; lapsed.current.delete(itemKey(task.item)) }
      // интро — знакомство, не вспоминание: FSRS не трогаем; отработка через пару карточек
      if (task.format === 'intro' && g !== Rating.Easy) {
        introduced.current.add(itemKey(task.item))
        sinceIntro.current = 0
        await markIntroduced(task.item)
        await advance(task.item, false, 2)
        return
      }

      const prevState = task.item.fsrs.state
      let rated
      try {
        rated = await rateItem(task.item, g, elapsed, task.format, verdict === null ? undefined : verdict !== 'wrong')
      } catch {
        // карточка исчезла (синк удалил/тьютор переименовал) — пропускаем, не блокируя сессию
        await advance(null)
        return
      }

      creditedSec.current += Math.min(elapsed, cardTimeCap(task.item.view.kind)) / 1000
      sinceIntro.current++
      // point 4: учитываем отработку слова в этой сессии — добор сегодняшних новых имеет предел
      drilled.current.set(itemKey(task.item), (drilled.current.get(itemKey(task.item)) ?? 0) + 1)

      // комбо верных подряд — чистый session-делайт, на FSRS не влияет
      const passed = verdict !== null ? verdict !== 'wrong' : g > Rating.Again
      setCombo(c => (passed ? c + 1 : 0))

      const r = res.current
      r.reviews++
      if (prevState === State.New) r.newSeen++
      // «Заново» на любой стадии → следующий показ этого слова будет окном-переznakomством «Подзабылось»;
      // вспомнил (не «Заново») → снимаем флаг подзабывания
      if (g === Rating.Again) {
        r.again++
        lapsed.current.add(itemKey(task.item))
        // C2: провал ×2 за сессию — слово уходит на завтра, из урока убирается (не переznakomим,
        // не крутим). Считаем по слову (path), а не по единице: и recall, и prep — одно слово.
        const p = task.item.view.path
        const fails = (sessionFails.current.get(p) ?? 0) + 1
        sessionFails.current.set(p, fails)
        if (fails >= 2) {
          deferredToday.current.add(p)
          lapsed.current.delete(itemKey(task.item))
          await deferItemToNextDay(task.item)
        }
      } else lapsed.current.delete(itemKey(task.item))
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
        await advance({ ...task.item, fsrs: rated.card })
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
        if (typed.trim()) submitObjective(typed, true)
      } else if ((e.code === 'Space' && !typing) || (e.code === 'Enter' && !typing)) {
        e.preventDefault()
        if (!revealed && task.format === 'reveal') setRevealed(true)
        else if (revealed && suggested) void grade(suggested)
      } else if (revealed && !suggested && !typing && ['1', '2', '3', '4'].includes(e.key)) {
        // ручная оценка 1–4 только у «показа»; в объективных форматах оценка авто
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
  // переznakomство: слово не смогли вспомнить («Заново») — то же окно, подпись «Подзабылось».
  // Ловим и внутрисессионный провал (lapsed, на любой стадии), и приход в Relearning из прошлой сессии.
  const isReintro = isIntro && (lapsed.current.has(itemKey(task.item)) || task.item.fsrs.state === State.Relearning)
  const sentence = task.ctx
  const answerWord = isPrep ? card.prep : task.format === 'mc' && card.choices.length >= 2 ? task.answer : card.word
  const isNumeric = !!card.answerNum
  const isAuthored = card.choices.length >= 2
  // «показ» тоже даёт ввести слово: самооценка без проверки завышает результат
  // («показалось знакомым»). Многословные ответы вводить не просим.
  const canTypeAnswer = task.format === 'reveal' && !card.word.includes(' ')
  // у ввода слова цель задана значением: иначе «popular» вместо «ubiquitous» — честный ответ носителя, а не ошибка
  const taskHint =
    task.cue === 'meaning' ? (canTypeAnswer || task.format === 'type' ? 'Какое это слово? Впишите его' : 'Какое это слово?')
    : task.format === 'mc' ? (isAuthored ? 'Выберите правильный вариант' : 'Какое слово подходит в пропуск?')
    : task.format === 'prep' ? 'Какой предлог здесь правильный?'
    : task.format === 'type' ? (isNumeric ? 'Решите и введите ответ' : card.meaning_ru ? `Впишите слово со значением «${card.meaning_ru}»` : 'Впишите слово, подходящее в пропуск')
    : canTypeAnswer ? 'Вспомните слово и впишите — или посмотрите ответ'
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
            <span className={`pill ${isReintro ? 'pill-yellow' : 'pill-green'}`}>{isReintro ? 'Подзабылось' : 'Новое слово'}</span>
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
        {task.cue === 'meaning' && !revealed ? (
          /* пример уже показан на знакомстве — вспоминаем слово по значению, а не по нему же */
          <div className="rev-cue">
            <div className="rev-cue-ru">{card.meaning_ru}</div>
            {card.meaning_en && <div className="rev-cue-en">{card.meaning_en}</div>}
          </div>
        ) : (
          <Sentence context={sentence} word={answerWord} revealed={revealed} />
        )}
        {!revealed && <div className="rev-task">{taskHint}</div>}
        {!revealed && (task.format === 'type' || canTypeAnswer) && (
          // поле ПОД предложением: всегда видно; кнопка «Проверить» — в нижнем листе,
          // который сам поднимается над клавиатурой (см. --kb).
          // В «показе» фокус не форсируем: сначала вспомнить молча, клавиатура — по тапу
          <input
            ref={inputRef}
            className="type-input"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onFocus={e => e.currentTarget.scrollIntoView({ block: 'nearest' })}
            placeholder={isNumeric ? 'Ваш ответ…' : 'Введите слово…'}
            inputMode={isNumeric ? 'decimal' : 'text'}
            autoFocus={task.format === 'type'}
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
            canTypeAnswer ? (
              <>
                <button className="btn btn-green" onClick={() => submitObjective(typed, true)} disabled={!typed.trim()}>
                  Проверить
                </button>
                <button className="intro-know" onClick={() => setRevealed(true)}>Не помню — показать ответ</button>
              </>
            ) : (
              <>
                <button className="btn btn-green" onClick={() => setRevealed(true)}>Показать ответ</button>
                <div className="hint-keys kb-only">Space — показать</div>
              </>
            )
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
            {suggested ? (
              /* объективный результат — оценка определена автоматически, выбор не нужен */
              <>
                <button className="btn btn-green btn-lg" onClick={() => void grade(suggested)}>Дальше</button>
                <div className="hint-keys kb-only">Enter — дальше</div>
              </>
            ) : (
              /* показ (learning-шаг) — объективного сигнала нет, оценивает пользователь */
              <>
                <div className="grades">
                  {GRADES.map(g => (
                    <button
                      key={g.key}
                      className={`btn grade-btn ${GRADE_CLASS[g.rating]}`}
                      onClick={() => void grade(g.rating)}
                    >
                      {g.label}
                      <span className="iv">{intervalLabel(scheduler, task.item.fsrs, g.rating, new Date())}</span>
                    </button>
                  ))}
                </div>
                <div className="hint-keys">Оценка решает, когда слово вернётся<span className="kb-only"> · клавиши 1–4</span></div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
