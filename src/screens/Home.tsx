import { useApp, views, readingViews, questionViews, setScreen, startSync, startLesson, logReading, unsyncedCount } from '../lib/store'
import { homeCounts, sectionOf, newBudgetFor, levelStats, activeLevel, type Section } from '../lib/scheduler'
import {
  streak, minutesToday, floorDays, reviewsByDay, readTextSlugs, readTextsToday, dayUnitsByDay,
  practiceUnitsByDay, MIN_MINUTES, READ_MIN_TEXTS, RUN_MIN_REVIEWS, type PauseRange
} from '../lib/journal'
import { DAY_NORMS, NORM_LEVELS, NORM_TITLE_GENITIVE, dayNormFill, dayNormStatus, newPerDay } from '../lib/norms'
import { sectionOrder, nextSection, SECTION_REASON, SECTION_TITLE } from '../lib/dayplan'
import { examReady, nextAttempt, practiceUnitRatio } from '../lib/metrics'
import { stageCounts, type WordStage } from '../lib/wordstatus'
import { dayKey } from '../lib/daytime'
import { Flame, Gear, Chart, Plus, Check, Bolt, Book } from '../components/Icon'
import { readingLevel } from '../lib/reading'
import { practiceStats, practiceDue, practiceSummaryLabel, type PracticeStats } from '../lib/practice'
import FlameBuddy from '../components/FlameBuddy'
import FjordScene from '../components/FjordScene'
import { множ } from '../lib/plural'
import type { CardView, ReadingView } from '../lib/types'

/** «1 упражнение · 3 упражнения · 12 упражнений» — подпись читается вслух, а не как счётчик. */
const упражнений = (n: number) => множ(n, 'упражнение', 'упражнения', 'упражнений')

function SectionBlock({ title, icon, badge, glyph, cards, budget, extraBudget, onStart, onReview, onExtra, levelLine, onPath }: {
  title: string
  icon: React.ReactNode
  badge: string
  glyph: string
  cards: CardView[]
  budget: number
  /** Остаток новых до МАКСИМУМА дня — запас сверх оптимума (norms.ts::NEW_PER_DAY). */
  extraBudget: number
  onStart: () => void
  onReview: () => void
  onExtra: () => void
  levelLine?: string
  onPath?: () => void
}) {
  const c = homeCounts(cards, budget)
  const reviewDue = c.learnDue + c.revDue
  const due = reviewDue + c.newAvail
  /* Стена «Всё повторено» при выбранном оптимуме — простой, а не отдых: до экзамена
     недели. Пока до максимума дня есть запас и есть что вводить, раздел предлагает
     урок сверх нормы. Честная стена остаётся ровно одна — взятый максимум. */
  const extraAvail = due === 0 ? homeCounts(cards, extraBudget).newAvail : 0
  return (
    <div className="card section-card">
      <span className="sec-glyph" style={{ ['--rune-shape' as string]: glyph } as React.CSSProperties} />
      <div className="hero-head">
        <span className="hero-title section-title">
          <span className={`sec-badge ${badge}`}>{icon}</span> {title}
        </span>
        <span className="hero-sub">{c.total ? `${c.total} карт.` : 'пока пусто'}</span>
      </div>
      {levelLine && onPath && (
        <button className="path-chip" onClick={onPath}>{levelLine}<span className="path-chip-arr">›</span></button>
      )}
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
      {extraAvail > 0 ? (
        <button className="btn btn-green section-btn" onClick={onExtra}>Ещё · {extraAvail}</button>
      ) : (
        <button className="btn btn-green section-btn" onClick={onStart} disabled={due === 0}>
          {due === 0
            ? <><Check size={18} /> {c.total === 0 ? 'Нет карточек' : extraBudget === 0 ? 'Максимум дня взят' : 'Всё повторено'}</>
            : `Учить · ${due}`}
        </button>
      )}
      {c.newAvail > 0 && reviewDue > 0 && (
        <button className="section-review" onClick={onReview}>Только повторить · {reviewDue}</button>
      )}
    </div>
  )
}

/**
 * Чтение — четвёртый блок рядом с разделами колоды.
 *
 * Вид тот же, что у раздела (`SectionBlock`), и это не косметика: чтение — вторая половина
 * защищённого минимума, и выглядеть оно должно ровней словам, а не сноской под ними. Числа
 * другие только потому, что у текста нет FSRS: показывать «повторить» и «новых» нечего,
 * есть доступное и прочитанное.
 */
function ReadingBlock({ texts, read, level, onOpen }: {
  texts: ReadingView[]
  read: ReadonlySet<string>
  level: number
  onOpen: () => void
}) {
  const done = texts.filter(t => read.has(t.slug)).length
  const left = texts.length - done
  return (
    <div className="card section-card">
      <span className="sec-glyph" style={{ ['--rune-shape' as string]: 'var(--rune-ansuz)' } as React.CSSProperties} />
      <div className="hero-head">
        <span className="hero-title section-title">
          <span className="sec-badge badge-gold"><Book size={18} /></span> Чтение
        </span>
        <span className="hero-sub">{texts.length ? `ступень ${level}` : 'пока пусто'}</span>
      </div>
      <div className="stats3">
        <div className={`stat stat-new${left ? '' : ' is-zero'}`}><div className="n">{left}</div><div className="t">доступно</div></div>
        <div className={`stat stat-due${done ? '' : ' is-zero'}`}><div className="n">{done}</div><div className="t">прочитано</div></div>
      </div>
      {texts.length > 0 && (
        <div className="mastery" title="доля прочитанных текстов">
          <div style={{ width: `${Math.round((done / texts.length) * 100)}%` }} />
        </div>
      )}
      <button className="btn btn-green section-btn" onClick={onOpen} disabled={texts.length === 0}>
        {texts.length === 0
          ? 'Текстов пока нет'
          : left === 0
            ? <><Check size={18} /> Все тексты прочитаны</>
            : `Читать · ${left}`}
      </button>
    </div>
  )
}

/**
 * Практика - пятый блок рядом с разделами колоды и чтением.
 *
 * Тот же приём, что у `ReadingBlock`: у вопроса нет FSRS, показывать «повторить» и «новых»
 * нечего - есть решённые вопросы и точность среди них. Подпись кнопки - счётчик оставшихся,
 * тем же способом, что у чтения (`left`), а не выдуманное число.
 *
 * `due` (WS4, `practiceDue`) - сколько отвеченных вопросов созрели для повтора по лёгкому
 * графику практики; показывается рядом со свежими только подписью, зачёт дня в счётчики
 * дневной цели не входит (это делает WS6a).
 */
function PracticeBlock({ stats, due, onOpen }: { stats: PracticeStats; due: number; onOpen: () => void }) {
  const left = stats.total - stats.solved
  const summaryLabel = practiceSummaryLabel(stats)
  return (
    <div className="card section-card">
      <span className="sec-glyph" style={{ ['--rune-shape' as string]: 'var(--rune-tiwaz)' } as React.CSSProperties} />
      <div className="hero-head">
        <span className="hero-title section-title">
          <span className="sec-badge badge-blue"><Check size={18} /></span> Практика
        </span>
        <span className="hero-sub">
          {stats.total ? `${stats.correct}/${stats.total} верно` : 'пока пусто'}
          {due > 0 ? ` · к повтору ${due}` : ''}
        </span>
      </div>
      <div className="stats3">
        <div className={`stat stat-new${left ? '' : ' is-zero'}`}><div className="n">{left}</div><div className="t">осталось</div></div>
        <div className={`stat stat-due${stats.solved ? '' : ' is-zero'}`}><div className="n">{stats.solved}</div><div className="t">отвечено</div></div>
        <div className={`stat stat-learn${stats.correct ? '' : ' is-zero'}`}><div className="n">{stats.correct}</div><div className="t">верно</div></div>
      </div>
      {stats.total > 0 && (
        <div className="mastery" title="доля решённых верно">
          <div style={{ width: `${Math.round((stats.correct / stats.total) * 100)}%` }} />
        </div>
      )}
      <button className="btn btn-green section-btn" onClick={onOpen} disabled={stats.total === 0}>
        {stats.total === 0
          ? 'Вопросов пока нет'
          : summaryLabel
            ? <><Check size={18} /> {summaryLabel}</>
            : `Практика · ${left}`}
      </button>
    </div>
  )
}

export default function Home() {
  const app = useApp()
  const today = dayKey()
  const all = views()
  const rw = all.filter(v => sectionOf(v) === 'rw')
  const logic = all.filter(v => sectionOf(v) === 'logic')
  const grammar = all.filter(v => sectionOf(v) === 'grammar')
  const math = all.filter(v => sectionOf(v) === 'math')
  /* Бюджет новых — свой у каждого раздела (`newBudgetFor`). Общий на колоду
     доставался тому, кого открывали первым, и остальные стояли с погашенной
     кнопкой «Всё повторено» поверх нетронутых карточек. */
  const budgetRw = newBudgetFor(rw, newPerDay('rw', 'norm'), app.journal, today)
  const budgetLogic = newBudgetFor(logic, newPerDay('logic', 'norm'), app.journal, today)
  const budgetGrammar = newBudgetFor(grammar, newPerDay('grammar', 'norm'), app.journal, today)
  const budgetMath = newBudgetFor(math, newPerDay('math', 'norm'), app.journal, today)
  // запас сверх оптимума - им живёт кнопка «Ещё» (урок сверх нормы)
  const extraRw = newBudgetFor(rw, newPerDay('rw', 'max'), app.journal, today)
  const extraLogic = newBudgetFor(logic, newPerDay('logic', 'max'), app.journal, today)
  const extraGrammar = newBudgetFor(grammar, newPerDay('grammar', 'max'), app.journal, today)
  const extraMath = newBudgetFor(math, newPerDay('math', 'max'), app.journal, today)
  const pause: PauseRange | null = app.settings.pauseFrom && app.settings.pauseTo
    ? { from: app.settings.pauseFrom, to: app.settings.pauseTo } : null
  const st = streak(app.journal, today, pause)
  const mins = minutesToday(app.journal)
  /* Полоса дня считается в УПРАЖНЕНИЯХ, а не в минутах: минутный порог за 41 сессию
     не был взят ни разу и работал как приговор. Число берём той же картой, по
     которой день зачитывается (`reviewsByDay` → `isDayDone`), а не отдельным
     подсчётом: два независимых счёта одного и того же разъезжаются. */
  const reviewsToday = reviewsByDay(app.journal).get(today) ?? 0
  /* Полоса дня (WS6b) - три сегмента, а не одна цифра: карточки и практика
     складываются в один и тот же зачёт дня (`dayUnitsByDay`, WS6a), у практики
     свой вес относительно карточки (`practiceUnitRatio`, metrics.ts). Норма и
     заливка обязаны считаться от ОБЩЕГО зачёта, а не только от карточек - иначе
     сорокаминутный заход в практику по-прежнему рисовал бы пустую полосу. */
  const unitRatio = practiceUnitRatio(app.journal)
  const practiceUnitsToday = practiceUnitsByDay(app.journal, unitRatio).get(today) ?? 0
  const unitsToday = dayUnitsByDay(app.journal, unitRatio).get(today) ?? 0
  const norm = dayNormStatus(unitsToday)
  /* Вторая половина защищённого минимума - норма чтения (WS6a) считается ТЕКСТАМИ,
     а не минутами (READ_MIN_TEXTS): каталог кончается за пять дней при норме
     30 мин/день, и метрика вставала на нуле не потому, что не читали, а потому,
     что читать больше нечего (см. journal.ts::READ_MIN_TEXTS). */
  const textsToday = readTextsToday(app.journal, today)
  const readDone = textsToday >= READ_MIN_TEXTS
  /* Считаем до БЛИЖАЙШЕЙ попытки (E3): до 03.10 это первая, после неё суперскорная 07.11.
     Показывать 96 дней там, где на деле 61, значит каждый день врать себе про запас
     времени; зажим Math.max(0, ...) врал ровно так же с другого конца - с 03.10 счётчик
     застывал нулём, хотя впереди ещё 35 дней подготовки ко второй попытке. */
  const attempt = nextAttempt()
  const daysToExam = Math.ceil((attempt.getTime() - Date.now()) / 86400_000)

  /* Числа главного экрана. `examReady` остаётся — но за ним теперь ходят в
     «Статистику»: здесь от него берётся только `total` (размер словарной
     колоды). На витрине — введено, закрепилось и дни с закрытым полом.
     Оба числа берутся из ОДНОЙ сводки (`stageCounts`, wordstatus.ts) — единого
     источника правды о состоянии слова, а не из двух самостоятельных выражений,
     которые могли бы разъехаться, как только у них появится третий потребитель. */
  const er = examReady(all, attempt)
  const stages = stageCounts(all)
  // тип стадии, а не строка: опечатка в имени иначе тихо дала бы ноль на витрине
  const stageN = (s: WordStage) => stages.find(x => x.stage === s)?.n ?? 0
  // «введено» = всё, кроме new и suspended: leech + learning + review + mature
  const introduced = stages.reduce((sum, x) => sum + (x.stage === 'new' || x.stage === 'suspended' ? 0 : x.n), 0)
  const matureCount = stageN('mature')
  const fd = floorDays(app.journal, today)

  /* Автозачёт пустого дня удалён 05.08.2026.
     Здесь стоял useEffect, который вызывал `creditEmptyDay()` при РЕНДЕРЕ этого
     экрана, если очередь пуста. Он закрыл 19 дней из 41 — серия держалась на
     открытии приложения, а не на занятии. Добитая очередь по-прежнему
     засчитывает день, но только через строку session с reviews > 0
     (см. `journal.emptyDays`). */
  const cAll = homeCounts(all, budgetRw + budgetLogic + budgetGrammar + budgetMath)

  const syncText =
    app.syncStatus === 'syncing' ? 'Синхронизация…'
    : app.syncStatus === 'offline' ? 'Офлайн — изменения сохранены локально'
    : app.syncStatus === 'error' ? `Ошибка синхронизации: ${app.syncError}`
    : app.syncError ? app.syncError
    : app.lastSyncAt ? `Синхронизировано ${new Date(app.lastSyncAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`
    : ''

  const go = (s: Section, reviewOnly = false) => () => startLesson(s, reviewOnly)
  const goExtra = (s: Section) => () => startLesson(s, false, true)

  /* Подпись полосы дня. Три числа впереди всегда: карточки, практика (в
     единицах, WS6a) и текст против нормы READ_MIN_TEXTS - это то, что человек
     сделал сегодня по каждому из трёх каналов. Дальше - состояние дня (пауза
     или зачёт) и следующая цель; когда взят максимум, подпись так и говорит -
     дальше идти незачем. */
  const dayCounts = `${упражнений(reviewsToday)} · практика ${Math.round(practiceUnitsToday)} · текст ${textsToday}/${READ_MIN_TEXTS}`
  const dayGoal = norm.next
    ? `до ${NORM_TITLE_GENITIVE[norm.next.level]} ${norm.next.target - unitsToday}`
    : 'максимум дня взят'
  const dayLabel = st.pausedToday
    ? `${dayCounts} · пауза до ${app.settings.pauseTo.slice(5).split('-').reverse().join('.')}`
    : st.todayDone
      ? `${dayCounts} · ${norm.next ? `зачтён · ${dayGoal}` : dayGoal}`
      : `${dayCounts} · ${dayGoal}`

  // строка активного уровня для блока «Слова»
  // Чтение: ступень выводится из прочитанного (readingLevel), а не спрашивается настройкой
  const texts = readingViews()
  const readSlugs = readTextSlugs(app.journal)
  const readLevel = readingLevel(texts, readSlugs)
  const practice = practiceStats(questionViews(), app.journal)
  const practiceDueCount = practiceDue(questionViews(), app.journal)

  const rwStats = levelStats(rw)
  const rwActive = activeLevel(rw)
  const curStat = rwStats.find(s => s.level === rwActive)
  const levelName = app.levelNames[String(rwActive)] ?? `Уровень ${rwActive}`
  const levelLine = curStat ? `${levelName} · ${curStat.introduced}/${curStat.total}` : undefined

  /* Приоритет дня (WS6b, lib/dayplan.ts) - разделы упорядочены по долгу перед
     весом RW цифрового SAT, а не в фиксированном порядке «Слова, Логика, …».
     Кнопка выше списка называет предмет, а не проценты (SECTION_REASON): цифра
     долга ничего не говорит ученику о том, чем заняться. */
  const today0 = nextSection(app.journal, all, today)
  const order = sectionOrder(app.journal, all, today)
  const sectionMeta: Record<Section, {
    title: string; icon: React.ReactNode; badge: string; glyph: string; cards: CardView[]
    budget: number; extraBudget: number; levelLine?: string; onPath?: () => void
  }> = {
    rw: { title: SECTION_TITLE.rw, icon: <Bolt size={18} />, badge: 'badge-blue', glyph: 'var(--rune-ansuz)', cards: rw, budget: budgetRw, extraBudget: extraRw, levelLine, onPath: () => setScreen('path') },
    logic: { title: SECTION_TITLE.logic, icon: <span className="sec-x">∴</span>, badge: 'badge-orange', glyph: 'var(--rune-tiwaz)', cards: logic, budget: budgetLogic, extraBudget: extraLogic },
    grammar: { title: SECTION_TITLE.grammar, icon: <span className="sec-x">¶</span>, badge: 'badge-green', glyph: 'var(--rune-ansuz)', cards: grammar, budget: budgetGrammar, extraBudget: extraGrammar },
    math: { title: SECTION_TITLE.math, icon: <span className="sec-x">∑</span>, badge: 'badge-purple', glyph: 'var(--rune-tiwaz)', cards: math, budget: budgetMath, extraBudget: extraMath }
  }

  return (
    <div className="screen s-home">
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

      {/* Главный экран больше не печатает «Готово к 03.10: 0 из 400 · отстаёшь
          на 175 дн».
          Оба числа были бесполезны и одно из них — неверно. «Готово» считает
          retrievability на 03.10 БЕЗ будущих повторов: при медианной
          стабильности колоды 1,4 дня и 59 днях до экзамена оно равно нулю по
          построению и останется нулём ещё недели — то есть не даёт обратной
          связи вообще. «Отстаёшь на 175 дн» при 59 оставшихся смешивало
          единицы: темп мерился выпусками в Review, а дефицит — «готовыми
          словами». Обе метрики живут в «Статистике», где к ним есть разрезы и
          подписи; на главном экране остаются два числа, которые двигаются от
          сегодняшнего действия.
          17.08.2026 сама цель «400 готовых» отменена (см. TARGET_REVIEW и
          TARGET_MATURE в metrics.ts), так что процитированной строки больше не
          существует нигде. Решение не печатать её здесь от этого не изменилось:
          вывод был не про конкретное число, а про то, что метрика без разрезов
          и подписей на главном экране не даёт обратной связи. */}
      {/* Вся плашка — кнопка на экран списка слов (`setScreen('words')`), а не только
          подпись: полоса и обе строки говорят об одном и том же прогрессе, и часть
          из них не должна выглядеть кликабельной, а часть — нет. Стрелка справа —
          тот же признак кнопки, что у `path-chip`/`path-chip-arr` в SectionBlock. */}
      <button
        type="button"
        className="card hero hero-slim hero-link"
        onClick={() => setScreen('words')}
        aria-label={`Список слов: ${introduced} из ${er.total} введено, ${matureCount} закрепилось`}
      >
        <div className="hero-head" style={{ marginBottom: 6 }}>
          <span className="hero-title">Слова</span>
          <span className="hero-sub"><b>{introduced}</b> из {er.total} введено <span className="path-chip-arr">›</span></span>
        </div>
        <div className="minbar-row" style={{ marginTop: 0, marginBottom: 4 }}>
          <div className="minbar"><div style={{ width: `${er.total ? Math.min(100, (introduced / er.total) * 100) : 0}%` }} /></div>
          <span className="minbar-label">
            {matureCount > 0 ? `${matureCount} закрепилось` : 'закрепившихся пока нет'}
          </span>
        </div>
      </button>

      <div className="card hero hero-slim">
        <div className="hero-head" style={{ marginBottom: 6 }}>
          <span className="hero-title">Дней с закрытым полом</span>
          <span className="hero-sub"><b>{fd.done}</b> из {fd.window}</span>
        </div>
        <div className="minbar-row" style={{ marginTop: 0, marginBottom: 4 }}>
          <div className="minbar"><div style={{ width: `${Math.min(100, (fd.done / fd.window) * 100)}%` }} /></div>
          <span className="minbar-label">пол дня — {RUN_MIN_REVIEWS} упражнений</span>
        </div>
      </div>

      <div className="card hero hero-slim">
        <div className="hero-head" style={{ marginBottom: 10 }}>
          <span className="hero-title">Сегодня</span>
          {/* Минуты не выброшены — они переехали сюда: время остаётся полезной
              справкой, но перестало быть шкалой дня. */}
          <span className="hero-sub">
            {daysToExam > 0 ? <>до SAT: {daysToExam} дн</> : <>SAT позади</>} <span className="rsep">·</span> завтра: {cAll.revTomorrow}
            <span className="rsep">·</span> {Math.floor(mins)}/{MIN_MINUTES} мин
          </span>
        </div>
        <div className="minbar-row" style={{ marginTop: 0 }}>
          {/* Три сегмента (WS6b): карточки заливкой, практика второй заливкой поверх
              того же счёта - обе части одного зачёта дня (`dayUnitsByDay`), а не два
              независимых числа с разным масштабом. */}
          <div className="minbar minbar-day">
            <div style={{ width: `${dayNormFill(reviewsToday) * 100}%` }} />
            <div
              className="minbar-seg-practice"
              style={{
                left: `${dayNormFill(reviewsToday) * 100}%`,
                width: `${Math.max(0, dayNormFill(unitsToday) - dayNormFill(reviewsToday)) * 100}%`
              }}
            />
            {/* Три нормы дня видны сразу: взятая засечка гаснет в зелёное, за
                невзятой видно, сколько осталось. */}
            {NORM_LEVELS.map(l => (
              <span
                key={l}
                className={`minbar-tick${unitsToday >= DAY_NORMS[l] ? ' is-hit' : ''}`}
                style={{ left: l === 'max' ? 'calc(100% - 2px)' : `calc(${(DAY_NORMS[l] / DAY_NORMS.max) * 100}% - 1px)` }}
                title={`${NORM_TITLE_GENITIVE[l]} - ${DAY_NORMS[l]}`}
              />
            ))}
          </div>
          <span className={`minbar-label${st.todayDone ? ' done' : ''}`}>{dayLabel}</span>
        </div>
        {/* Чтение - вторая половина минимума. Отдельной полосой, а не в общем
            зачёте: подменять текст карточками нельзя, это разные навыки.
            Полоса чтения считает ТЕКСТЫ (READ_MIN_TEXTS), не минуты - см. journal.ts. */}
        <div className="minbar-row">
          <div className="minbar"><div style={{ width: `${Math.min(100, (textsToday / READ_MIN_TEXTS) * 100)}%` }} /></div>
          <span className={`minbar-label${readDone ? ' done' : ''}`}>
            текст {textsToday}/{READ_MIN_TEXTS}
          </span>
          <button
            className="read-add"
            onClick={() => {
              const ответ = window.prompt('Сколько минут читал?', '30')
              if (!ответ) return
              const n = Number(ответ.replace(',', '.'))
              if (!Number.isFinite(n) || n <= 0) return
              const что = window.prompt('Что читал? (можно пропустить)', '') ?? ''
              void logReading(n, что)
            }}
            aria-label="Отметить чтение"
          >+</button>
        </div>
        {st.freezeSpentYesterday && <div className="freeze-note">❄ Заморозка спасла серию — осталось {st.freezes}</div>}
      </div>

      {/* Приоритет дня - одна первичная кнопка над разделами (WS6b): называет
          ПРЕДМЕТ (SECTION_REASON), а не долю долга, которую посчитал dayplan.ts. */}
      <button type="button" className="btn btn-green section-btn today-btn" onClick={go(today0)}>
        Сегодня: {sectionMeta[today0].title}
      </button>
      <div className="minbar-label today-reason">{SECTION_REASON[today0]}</div>
      {order.map(s => (
        <SectionBlock
          key={s}
          title={sectionMeta[s].title}
          icon={sectionMeta[s].icon}
          badge={sectionMeta[s].badge}
          glyph={sectionMeta[s].glyph}
          cards={sectionMeta[s].cards}
          budget={sectionMeta[s].budget}
          extraBudget={sectionMeta[s].extraBudget}
          onStart={go(s)}
          onReview={go(s, true)}
          onExtra={goExtra(s)}
          levelLine={sectionMeta[s].levelLine}
          onPath={sectionMeta[s].onPath}
        />
      ))}
      <ReadingBlock texts={texts} read={readSlugs} level={readLevel} onOpen={() => setScreen('reading')} />
      <PracticeBlock stats={practice} due={practiceDueCount} onOpen={() => setScreen('practice')} />

      <div className="home-actions">
        <div className="row">
          <button className="btn btn-white" onClick={() => setScreen('add')}><Plus size={18} /> Слово</button>
          <button className="btn btn-white" onClick={() => void startSync()}>Синк</button>
        </div>
      </div>

      {/* F30: `warning` (карточка ждёт починки файла, git-конфликт) подсвечивается как ошибка -
          это не сводка, а просьба сходить в vault; текст приходит из res.warning через syncError. */}
      <div className={`syncline${app.syncStatus === 'error' || app.syncStatus === 'warning' ? ' err' : ''}`}>{syncText}</div>
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
