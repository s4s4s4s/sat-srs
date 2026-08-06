import { useEffect, useMemo, useRef, useState } from 'react'
import { Rating, State, type Grade } from 'ts-fsrs'
import { useApp, views, rateItem, finishSession, setScreen, startSync, currentJournal, setCause, markIntroduced, deferItemToNextDay } from '../lib/store'
import type { CardView } from '../lib/types'
import {
  buildQueue, makeScheduler, intervalLabel, shouldRequeue, requeuePosition, GRADES,
  pickFormat, mcDistractors, prepOptions, checkTyped, checkNumeric, suggestedGrade, sectionOf, itemKey, effectiveRetention, NEW_GAP,
  earlyFillers, MAX_EARLY_FILLERS, MAX_INTRO_BONUS, nextNewItems, nextCtxIndex
} from '../lib/scheduler'
import { pickNext, hasSeparator, screenFormat, isGiveUp, type OrderCtx } from '../lib/session'
import Tex from '../components/Tex'
import { newIntroducedOn, minutesToday, MIN_MINUTES, cardTimeCap, forcedTodaySlugs } from '../lib/journal'
import { speedStats } from '../lib/metrics'
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

/* Индекс последнего показанного примера. Живёт в localStorage, а не в памяти модуля:
   PWA открывается заново на каждый урок, и Map обнулялась вместе с ним — ротация
   всегда начиналась с contexts[0]. При 1–2 показах карточки за урок это значило, что
   второй и третий примеры ученик практически не видел (C7). */
const CTX_IDX_KEY = 'srs.ctxIdx'

function readCtxIdx(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CTX_IDX_KEY)
    const val = raw ? JSON.parse(raw) : null
    return val && typeof val === 'object' ? val as Record<string, number> : {}
  } catch { return {} }
}

function writeCtxIdx(map: Record<string, number>) {
  try { localStorage.setItem(CTX_IDX_KEY, JSON.stringify(map)) } catch { /* приватный режим/квота — ротация просто пойдёт от reps */ }
}

/** Ротация контекстов round-robin: каждый показ — следующее предложение, полный цикл до повтора */
function pickContext(view: CardView, reps: number): string {
  const pool = view.contexts.length ? view.contexts : [view.context]
  const map = readCtxIdx()
  const idx = nextCtxIndex(map[view.path], reps, pool.length)
  map[view.path] = idx
  writeCtxIdx(map)
  return pool[idx]
}

function makeTask(item: StudyItem, deck: ReturnType<typeof views>, introduced?: Set<string>, lapsed?: Set<string>, reintroAllowed = true, typing = false): Task {
  const format = pickFormat(item, deck.map(r => r), introduced, lapsed, reintroAllowed, typing)
  const ctx = format === 'prep' ? item.view.prepContext : pickContext(item.view, item.fsrs.reps)
  /* Если у слова один пример и он уже показан, спрашивать по нему нельзя: это
     проверка памяти на предложение, а не на слово. Тогда цель — значение. Это же
     ветка mc-meaning для 105 словарных карточек, у которых контекст один вместо
     трёх, требуемых контрактом (замер 06.08.2026: 313 карточек с тремя примерами,
     105 с одним, ещё 32 — с авторскими вариантами, им контексты не положены).

     Пример «сгорает» не только внутри урока: у карточки с единственным контекстом
     следующие уроки показывают ДОСЛОВНО то же предложение, и заучивается связка
     предложение→слово — вторая жалоба Александра 06.08.2026. Поэтому потраченным
     пример считается с первой оценки (reps > 0), а не только в пределах сессии.
     Карточек с авторскими вариантами (error/grammar/math) это не касается: у них
     «контекст» — формулировка вопроса, и значения слова нет. */
  const exampleSpent = item.view.contexts.length < 2 && !item.view.choices.length &&
    (introduced?.has(itemKey(item)) || item.fsrs.reps > 0)
  const cue: Task['cue'] =
    (format === 'reveal' || format === 'type' || format === 'mc') && exampleSpent && !item.view.answerNum && !!item.view.meaning_ru
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

  /* Очередь строится СРАЗУ из локальной колоды, синк уходит в фон.
     Раньше здесь стоял `await Promise.race([startSync(), 3500])`: урок не
     начинался, пока не ответит сеть, — до трёх с половиной секунд ожидания
     перед первым вопросом, каждый раз. При медианной длине сессии 0,78 минуты
     это пятая часть занятия, потраченная на пустой экран, и ровно та цена
     входа, из-за которой приложение не открывают.
     Свежие карточки тьютора теперь попадают не в этот урок, а в следующий —
     цена, которую стоит платить: карточки заливаются пачками раз в несколько
     дней, а уроков в день должно быть несколько. */
  const [queue, setQueue] = useState<StudyItem[] | null>(null)
  useEffect(() => {
    // новых за урок — не больше newPerLesson (и не больше остатка дневного лимита);
    // режим «только повторение» — ноль новых
    const dayLeft = Math.max(0, app.settings.newPerDay - newIntroducedOn(currentJournal(), dayKey()))
    const budget = app.sessionReviewOnly ? 0 : Math.min(dayLeft, app.settings.newPerLesson || 3)
    dayNewLeft.current = dayLeft   // граница для добора новых сверх урочного лимита
    // point 3: слова, введённые сегодня в прошлых уроках и ещё не отработанные дважды,
    // принудительно добираются в этот урок (buildQueue дотягивает их из Learning с due на завтра)
    const forced = forcedTodaySlugs(currentJournal(), dayKey())
    setQueue(buildQueue(views().filter(v => sectionOf(v) === section), budget, new Date(), forced))
    if (app.settings.pat && navigator.onLine) void startSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [task, setTask] = useState<Task | null>(() => null)
  const [revealed, setRevealed] = useState(false)
  const [picked, setPicked] = useState<string | null>(null) // выбранный вариант mc/prep
  const [typed, setTyped] = useState('')
  const [verdict, setVerdict] = useState<'correct' | 'typo' | 'wrong' | null>(null)
  // C3/C4: карточка раскрыта через «не помню» (или пустой ввод) — ответ показан, но оценку
  // не спрашиваем: рейтинг фиксирован Again. Кнопки «Хорошо»/«Легко» в этом случае не рисуются.
  const [gaveUp, setGaveUp] = useState(false)
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
  // урочный лимит окон-знакомств; introBonus поднимает его, когда иначе уроку нечего показать
  const baseIntroLimit = Math.max(1, app.settings.newPerLesson || 3)
  const introBonus = useRef(0)
  const introLimitNow = () => baseIntroLimit + introBonus.current
  // знакомств НОВЫХ слов за сессию и остаток дневного лимита — граница для добора сверх урочного
  const freshIntros = useRef(0)
  const dayNewLeft = useRef(0)
  // сколько отработок прошло с прошлого знакомства (новые слова не идут пачкой)
  const sinceIntro = useRef(NEW_GAP)
  // A4-bis: знакомств подряд без оценённой отработки между ними — батч, когда разбавлять нечем
  const batchIntros = useRef(0)
  // B4: сколько заполнителей (ранних повторов) урок уже подтянул — потолок MAX_EARLY_FILLERS
  const fillersUsed = useRef(0)
  // point 2: время последнего показа каждой единицы — не показываем одну карту чаще, чем раз в минуту
  const shownTimes = useRef(new Map<string, number>())
  // point 4: сколько раз слово отработано в ЭТОЙ сессии — добор сегодняшних новых имеет предел
  const drilled = useRef(new Map<string, number>())
  // A3/A4: слово и «знакомство ли» предыдущего показанного экрана — очередь не ставит два экрана
  // одного слова встык (A3) и не выдаёт два знакомства подряд без упражнения между ними (A4)
  const lastShownPath = useRef<string | null>(null)
  const lastWasIntro = useRef(false)
  // itemKey, чей последний показ был окном-знакомством: их отработка допускается раньше (INTRO_GAP_MS)
  const introPending = useRef(new Set<string>())
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
    // окно-знакомство выдаём только если урок сможет его отработать. Два запрета:
    // — новое сверх урочного лимита окон (переznakomство уже съело бюджет) ждёт следующего урока;
    // — A6: нечем развести знакомство и первую отработку (A3) → знакомство не показывается вовсе,
    //   слово остаётся New без first_seen. Показать и бросить хуже, чем не показать: слово
    //   числится введённым, не выучено, и следующий урок повторяет его один в один.
    if (screenFormat(head, orderCtx(queue ?? [])) === 'intro') {
      const freshNew = head.fsrs.state === State.New && !introduced.current.has(itemKey(head))
      const overLimit = freshNew && introShown.current >= introLimitNow()
      if (overLimit || !hasSeparator(queue ?? [head], 0, orderCtx(queue ?? []))) {
        void proceed((queue ?? []).slice(1))
        return
      }
    }
    const shown = makeTask(head, deck, introduced.current, lapsed.current, introShown.current < introLimitNow(), app.settings.typing)
    setTask(shown)
    // point 2/A2: отметка момента показа этой единицы — pickNextIndex держит 60-секундный разрыв
    shownTimes.current.set(itemKey(head), Date.now())
    // A3/A4: что показано этим экраном — вход для следующего выбора очереди
    lastShownPath.current = head.view.path
    lastWasIntro.current = shown.format === 'intro'
    if (shown.format === 'intro') introPending.current.add(itemKey(head))
    else introPending.current.delete(itemKey(head))
    setRevealed(false)
    setPicked(null)
    setTyped('')
    setVerdict(null)
    setGaveUp(false)
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

  /* Личная медиана времени ответа — база для порога «медленно».
     Считается один раз за урок: внутри урока она не меняется, а пересчёт на
     каждый экран гонял бы весь журнал. */
  const personalMedianMs = useMemo(() => speedStats(app.journal).medianMs, [])

  // в «показе» вердикт появляется, только если пользователь сам ввёл слово —
  // тогда сигнал объективный и оценка считается как у ввода.
  // C3: «не помню» — рейтинг фиксирован Again, выбора оценки нет (одна кнопка «Дальше»).
  const suggested = task && gaveUp
    ? Rating.Again
    : task && verdict !== null
    ? suggestedGrade(task.format === 'reveal' ? 'type' : task.format, verdict === 'correct', verdict === 'typo', answeredMs.current, task.item.view.kind, personalMedianMs)
    : null

  async function finish(queueEmpty: boolean) {
    if (finished.current) return // двойной тап ✕ / финиш после финиша не пишет дубль session-строки
    finished.current = true
    res.current.durMs = activeSec * 1000
    res.current.queueEmpty = queueEmpty
    await finishSession(res.current)
  }

  /** Текущий контекст выбора следующего экрана (A2/A3/A4/A4-bis/A6) — снимок refs в момент вызова. */
  function orderCtx(extra: StudyItem[] = []): OrderCtx {
    return {
      deck,
      introduced: introduced.current,
      lapsed: lapsed.current,
      reintroAllowed: introShown.current < introLimitNow(),
      typing: app.settings.typing,
      introsLeft: introLimitNow() - introShown.current,
      shownTimes: shownTimes.current,
      drilled: drilled.current,
      introPending: introPending.current,
      now: Date.now(),
      lastPath: lastShownPath.current,
      lastWasIntro: lastWasIntro.current,
      sinceIntro: sinceIntro.current,
      batchIntros: batchIntros.current,
      // A6: знакомство можно выдавать, если урок способен развести его с первой отработкой —
      // в т.ч. заполнителем, который ещё не подтянут в очередь
      hasFiller: availableFillers(extra).length > 0
    }
  }

  /**
   * B4, третья ступень лестницы: повторы, срок которых наступит в пределах суток. Подтягиваются
   * только когда урок иначе встанет (см. proceed) и не больше MAX_EARLY_FILLERS за урок.
   */
  function availableFillers(exclude: StudyItem[]): StudyItem[] {
    if (fillersUsed.current >= MAX_EARLY_FILLERS) return []
    const used = new Set(exclude.map(itemKey))
    return earlyFillers(deck, new Date(), used, MAX_EARLY_FILLERS - fillersUsed.current)
      .filter(i => !deferredToday.current.has(i.view.path) && !drilled.current.has(itemKey(i)))
  }

  /**
   * Последняя ступень лестницы: ещё одно новое слово сверх урочного лимита. Урочный лимит —
   * про комфортный темп, ДНЕВНОЙ (`newPerDay`) — про нагрузку на память; здесь уступает
   * только первый, и лишь когда альтернатива — пустой экран.
   */
  function bonusNew(exclude: StudyItem[]): StudyItem[] {
    if (app.sessionReviewOnly) return []              // режим «только повторение» — новых не вводим
    if (introBonus.current >= MAX_INTRO_BONUS) return []
    if (freshIntros.current >= dayNewLeft.current) return []
    const used = new Set(exclude.map(itemKey))
    return nextNewItems(deck, used, 1).filter(i => !deferredToday.current.has(i.view.path))
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
      // B4: сюда же попадает слово в состоянии New — знакомство рейтинга не даёт, и слово,
      // которому урок показал знакомство, остаётся New до первой оценки. Прежний фильтр
      // (только Learning/Relearning) такое слово не видел, и добирать было «нечего»
      .filter(v => forced.has(v.slug) && v.fsrs.state !== State.Review)
      .map(v => ({ view: v, skill: 'recall' as const, fsrs: v.fsrs }))
      .filter(i => (drilled.current.get(itemKey(i)) ?? 0) < DRILL_PER_SESSION)
  }

  /**
   * Лестница добора (B3/B4): показать следующий экран, а если сейчас показывать нечего —
   * сначала добрать, а не заканчивать урок.
   *   1) первая допустимая единица очереди (A2/A3/A4, затем батч знакомств A4-bis);
   *   2) недоработанные сегодняшние слова (в т.ч. New после знакомства);
   *   3) заполнитель — повтор со сроком в пределах суток, поднятый заранее;
   *   4) единственное препятствие — 60-секундный разрыв A2 → короткая пауза, не конец урока;
   *   5) и только если добирать действительно нечего — урок завершён.
   */
  async function proceed(list: StudyItem[]) {
    let rest = list
    let pick = pickNext(rest, orderCtx(rest))
    if (pick.idx < 0) {
      const extra = topUp().filter(i =>
        !deferredToday.current.has(i.view.path) && !rest.some(r => itemKey(r) === itemKey(i)))
      if (extra.length) { rest = [...rest, ...extra]; pick = pickNext(rest, orderCtx(rest)) }
    }
    if (pick.idx < 0) {
      const fill = availableFillers(rest)
      if (fill.length) {
        rest = [...rest, ...fill]
        fillersUsed.current += fill.length
        pick = pickNext(rest, orderCtx(rest))
      }
    }
    if (pick.idx < 0) {
      // последняя ступень: лишнее новое слово сверх УРОЧНОГО лимита (дневной не трогаем).
      // Лучше ввести четвёртое слово, чем оставить ученика без экрана
      const bonus = bonusNew(rest)
      if (bonus.length) {
        rest = [...rest, ...bonus]
        introBonus.current += bonus.length
        pick = pickNext(rest, orderCtx(rest))
      }
    }
    // лестница пройдена: если и теперь ничего — разрешаем аварийный пол разрыва (30 c),
    // чтобы вместо простоя или потери введённого слова дать показ на тридцатой секунде
    if (pick.idx < 0) pick = pickNext(rest, orderCtx(rest), true)
    if (pick.idx < 0) {
      // добирать нечего и всё, что осталось, нарушило бы инвариант — урок закончен (B3)
      setQueue([])
      // point 5: finish дожидается finishSession — строка session пишется ПОСЛЕ того,
      // как await rateItem последней карточки уже занёс её review-строку (иначе итоги занижены)
      await finish(true)
      return
    }
    const q = [...rest]
    if (pick.idx > 0) {
      const [it] = q.splice(pick.idx, 1)
      q.unshift(it)
    }
    setDone(d => d + 1)
    setQueue(q)
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
        // null означает «очередь короче, чем нужно ждать»: возвращать раньше
        // срока нельзя — так модель и решила, что слова забываются за часы.
        const pos = requeuePosition(rest.length, next.fsrs, new Date())
        if (pos !== null) rest.splice(pos, 0, next)
      }
    }
    await proceed(rest)
  }

  async function pickCauseAndGo(c: string | null) {
    if (causeFor && c) await setCause(causeFor, c)
    setCauseFor(null)
    const p = pendingAdvance.current
    pendingAdvance.current = null
    if (p) await advance(p.next, p.atFront)
  }

  /**
   * C3/C4: честный выход «не помню» — показать ответ и зафиксировать Again, без запроса оценки.
   * Работает во всех форматах ввода/показа (reveal и type). Оценка не спрашивается: suggested = Again.
   */
  function giveUp() {
    if (!task || revealed) return
    answeredMs.current = Date.now() - shownAt.current
    setGaveUp(true)
    setRevealed(true)
  }

  /** Ответ в объективных форматах: фиксируем результат и открываем ответ с предложенной оценкой */
  function submitObjective(value: string, byTyping = false) {
    if (!task || revealed) return
    // C4: пустой/пробельный ответ — не ошибка ввода, а «не помню» (тот же путь, что кнопка)
    if (isGiveUp(value)) { giveUp(); return }
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
        // A4-bis: счётчик батча растёт до первой оценённой отработки
        batchIntros.current++
        // знакомства новых слов считаем отдельно: дневной лимит про них, а не про «Подзабылось»
        if (task.item.fsrs.state === State.New) freshIntros.current++
        await markIntroduced(task.item)
        await advance(task.item, false, 2)
        return
      }

      const prevState = task.item.fsrs.state
      const isTypo = verdict === 'typo'
      let rated
      try {
        rated = await rateItem(task.item, g, elapsed, task.format, verdict === null ? undefined : verdict !== 'wrong', gaveUp, isTypo)
      } catch {
        // карточка исчезла (синк удалил/тьютор переименовал) — пропускаем, не блокируя сессию
        await advance(null)
        return
      }

      creditedSec.current += Math.min(elapsed, cardTimeCap(task.item.view.kind)) / 1000
      sinceIntro.current++
      // A4-bis: оценённая отработка закрывает батч знакомств — следующее знакомство снова по A4
      batchIntros.current = 0
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

      // причина ошибки — только для зрелых (Review) карточек: провал на learning = «ещё не выучил».
      // C3: честное «не помню» ход не тормозит — разбор причины не спрашиваем (незнание слова само по себе причина).
      const wrong = verdict === 'wrong' || (verdict === null && g === Rating.Again && task.format !== 'intro')
      if (wrong && prevState === State.Review && !gaveUp) {
        pendingAdvance.current = { next: { ...task.item, fsrs: rated.card }, atFront: false }
        setCauseFor(rated.lineId)
      } else if (isTypo) {
        // опечатка: интервал FSRS не рушим (оценка Good), но слово переспрашивается в этом же
        // уроке — вернём его в очередь через несколько экранов (A2-разрыв соблюдёт pickNext)
        await advance({ ...task.item, fsrs: rated.card }, false, 3)
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
        submitObjective(typed, true) // C4: пустое поле → «не помню» внутри submitObjective
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
    : task.format === 'type' ? (isNumeric ? 'Решите и введите ответ' : `Впишите слово со значением «${card.meaning_ru || card.meaning_en}»`)
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
                {/* C4: пустой «Проверить» не блокируется — он эквивалентен «не помню» (submitObjective → giveUp) */}
                <button className="btn btn-green" onClick={() => submitObjective(typed, true)}>
                  Проверить
                </button>
                {/* C3: «не помню» ставит Again и показывает ответ, без ряда оценок Хорошо/Легко */}
                <button className="intro-know" onClick={() => giveUp()}>Не помню — показать ответ</button>
              </>
            ) : (
              <>
                <button className="btn btn-green" onClick={() => setRevealed(true)}>Показать ответ</button>
                <div className="hint-keys kb-only">Space — показать</div>
              </>
            )
          ) : task.format === 'type' ? (
            <>
              {/* C4: пустой «Проверить» = «не помню» (submitObjective → giveUp), поэтому без disabled */}
              <button className="btn btn-green" onClick={() => submitObjective(typed)}>
                Проверить
              </button>
              {/* C3: в форматах с вводом кнопка «не помню» обязательна — не заставляем гадать вслепую */}
              <button className="intro-know" onClick={() => giveUp()}>Не помню — показать ответ</button>
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
