import { useApp, views, readingViews, setScreen, startSync, startLesson, logReading, unsyncedCount } from '../lib/store'
import { homeCounts, sectionOf, newBudgetFor, levelStats, activeLevel, isLevelled, type Section } from '../lib/scheduler'
import { streak, minutesToday, readMinutesToday, floorDays, reviewsByDay, readTextSlugs, MIN_MINUTES, READ_MIN_MINUTES, RUN_MIN_REVIEWS, type PauseRange } from '../lib/journal'
import { DAY_NORMS, NEW_PER_DAY, NORM_LEVELS, NORM_TITLE_GENITIVE, dayNormFill, dayNormStatus } from '../lib/norms'
import { examReady, maturity, PRIMARY_DATE } from '../lib/metrics'
import { State } from 'ts-fsrs'
import { dayKey } from '../lib/daytime'
import { Flame, Gear, Chart, Plus, Check, Bolt, Book } from '../components/Icon'
import { readingLevel } from '../lib/reading'
import FlameBuddy from '../components/FlameBuddy'
import FjordScene from '../components/FjordScene'
import type { CardView, ReadingView } from '../lib/types'

/** «1 упражнение · 3 упражнения · 12 упражнений» — подпись читается вслух, а не как счётчик. */
function упражнений(n: number): string {
  const ten = n % 100
  const one = n % 10
  const слово = ten >= 11 && ten <= 14 ? 'упражнений'
    : one === 1 ? 'упражнение'
    : one >= 2 && one <= 4 ? 'упражнения'
    : 'упражнений'
  return `${n} ${слово}`
}

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
            ? <><Check size={18} /> {extraBudget === 0 ? 'Максимум дня взят' : 'Всё повторено'}</>
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

export default function Home() {
  const app = useApp()
  const today = dayKey()
  const all = views()
  const rw = all.filter(v => sectionOf(v) === 'rw')
  const grammar = all.filter(v => sectionOf(v) === 'grammar')
  const math = all.filter(v => sectionOf(v) === 'math')
  /* Бюджет новых — свой у каждого раздела (`newBudgetFor`). Общий на колоду
     доставался тому, кого открывали первым, и остальные стояли с погашенной
     кнопкой «Всё повторено» поверх нетронутых карточек. */
  const budgetRw = newBudgetFor(rw, NEW_PER_DAY.norm, app.journal, today)
  const budgetGrammar = newBudgetFor(grammar, NEW_PER_DAY.norm, app.journal, today)
  const budgetMath = newBudgetFor(math, NEW_PER_DAY.norm, app.journal, today)
  // запас сверх оптимума — им живёт кнопка «Ещё» (урок сверх нормы)
  const extraRw = newBudgetFor(rw, NEW_PER_DAY.max, app.journal, today)
  const extraGrammar = newBudgetFor(grammar, NEW_PER_DAY.max, app.journal, today)
  const extraMath = newBudgetFor(math, NEW_PER_DAY.max, app.journal, today)
  const pause: PauseRange | null = app.settings.pauseFrom && app.settings.pauseTo
    ? { from: app.settings.pauseFrom, to: app.settings.pauseTo } : null
  const st = streak(app.journal, today, pause)
  const mins = minutesToday(app.journal)
  /* Полоса дня считается в УПРАЖНЕНИЯХ, а не в минутах: минутный порог за 41 сессию
     не был взят ни разу и работал как приговор. Число берём той же картой, по
     которой день зачитывается (`reviewsByDay` → `isDayDone`), а не отдельным
     подсчётом: два независимых счёта одного и того же разъезжаются. */
  const reviewsToday = reviewsByDay(app.journal).get(today) ?? 0
  const norm = dayNormStatus(reviewsToday)
  // Вторая половина защищённого минимума. До сих пор её не было видно нигде,
  // и в «Метриках» семь недель подряд стоит «0/7 (не трекается)».
  const readMins = readMinutesToday(app.journal)
  const readDone = readMins >= READ_MIN_MINUTES
  // Считаем до ПЕРВОЙ попытки, а не до суперскорной: показывать 96 дней там,
  // где на деле 61, — значит каждый день врать себе про запас времени.
  const daysToExam = Math.max(0, Math.ceil((PRIMARY_DATE.getTime() - Date.now()) / 86400_000))

  /* Числа главного экрана. `examReady` остаётся — но за ним теперь ходят в
     «Статистику»: здесь от него берётся только `total` (размер словарной
     колоды). На витрине — введено, закрепилось и дни с закрытым полом. */
  const er = examReady(all, PRIMARY_DATE)
  const mat = maturity(all)
  const introduced = all.filter(v => isLevelled(v) && !v.suspended && v.fsrs.state !== State.New).length
  const fd = floorDays(app.journal, today)

  /* Автозачёт пустого дня удалён 05.08.2026.
     Здесь стоял useEffect, который вызывал `creditEmptyDay()` при РЕНДЕРЕ этого
     экрана, если очередь пуста. Он закрыл 19 дней из 41 — серия держалась на
     открытии приложения, а не на занятии. Добитая очередь по-прежнему
     засчитывает день, но только через строку session с reviews > 0
     (см. `journal.emptyDays`). */
  const cAll = homeCounts(all, budgetRw + budgetGrammar + budgetMath)

  const syncText =
    app.syncStatus === 'syncing' ? 'Синхронизация…'
    : app.syncStatus === 'offline' ? 'Офлайн — изменения сохранены локально'
    : app.syncStatus === 'error' ? `Ошибка синхронизации: ${app.syncError}`
    : app.syncError ? app.syncError
    : app.lastSyncAt ? `Синхронизировано ${new Date(app.lastSyncAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`
    : ''

  const go = (s: Section, reviewOnly = false) => () => startLesson(s, reviewOnly)
  const goExtra = (s: Section) => () => startLesson(s, false, true)

  /* Подпись полосы дня. Число упражнений впереди всегда: это то, что человек
     сделал сегодня. Дальше — состояние дня (пауза или зачёт) и следующая цель;
     когда взят максимум, подпись так и говорит — дальше идти незачем. */
  const dayGoal = norm.next
    ? `до ${NORM_TITLE_GENITIVE[norm.next.level]} ${norm.next.target - reviewsToday}`
    : 'максимум дня взят'
  const dayLabel = st.pausedToday
    ? `${упражнений(reviewsToday)} · пауза до ${app.settings.pauseTo.slice(5).split('-').reverse().join('.')}`
    : st.todayDone
      ? `${упражнений(reviewsToday)} · ${norm.next ? `зачтён · ${dayGoal}` : dayGoal}`
      : `${упражнений(reviewsToday)} · ${dayGoal}`

  // строка активного уровня для блока «Слова»
  // Чтение: ступень выводится из прочитанного (readingLevel), а не спрашивается настройкой
  const texts = readingViews()
  const readSlugs = readTextSlugs(app.journal)
  const readLevel = readingLevel(texts, readSlugs)

  const rwStats = levelStats(rw)
  const rwActive = activeLevel(rw)
  const curStat = rwStats.find(s => s.level === rwActive)
  const levelName = app.levelNames[String(rwActive)] ?? `Уровень ${rwActive}`
  const levelLine = curStat ? `${levelName} · ${curStat.introduced}/${curStat.total}` : undefined

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
      <div className="card hero hero-slim">
        <div className="hero-head" style={{ marginBottom: 6 }}>
          <span className="hero-title">Слова</span>
          <span className="hero-sub"><b>{introduced}</b> из {er.total} введено</span>
        </div>
        <div className="minbar-row" style={{ marginTop: 0, marginBottom: 4 }}>
          <div className="minbar"><div style={{ width: `${er.total ? Math.min(100, (introduced / er.total) * 100) : 0}%` }} /></div>
          <span className="minbar-label">
            {mat.matureCount > 0 ? `${mat.matureCount} закрепилось` : 'закрепившихся пока нет'}
          </span>
        </div>
      </div>

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
            до SAT: {daysToExam} дн <span className="rsep">·</span> завтра: {cAll.revTomorrow}
            <span className="rsep">·</span> {Math.floor(mins)}/{MIN_MINUTES} мин
          </span>
        </div>
        <div className="minbar-row" style={{ marginTop: 0 }}>
          <div className="minbar minbar-day">
            <div style={{ width: `${dayNormFill(reviewsToday) * 100}%` }} />
            {/* Три нормы дня видны сразу: взятая засечка гаснет в зелёное, за
                невзятой видно, сколько осталось. */}
            {NORM_LEVELS.map(l => (
              <span
                key={l}
                className={`minbar-tick${reviewsToday >= DAY_NORMS[l] ? ' is-hit' : ''}`}
                style={{ left: l === 'max' ? 'calc(100% - 2px)' : `calc(${(DAY_NORMS[l] / DAY_NORMS.max) * 100}% - 1px)` }}
                title={`${NORM_TITLE_GENITIVE[l]} — ${DAY_NORMS[l]}`}
              />
            ))}
          </div>
          <span className={`minbar-label${st.todayDone ? ' done' : ''}`}>{dayLabel}</span>
        </div>
        {/* Чтение — вторая половина минимума. Отдельной полосой, а не в общем
            зачёте: подменять тридцать минут чтения пятнадцатью минутами
            карточек нельзя, это разные навыки. */}
        <div className="minbar-row">
          <div className="minbar"><div style={{ width: `${Math.min(100, (readMins / READ_MIN_MINUTES) * 100)}%` }} /></div>
          <span className={`minbar-label${readDone ? ' done' : ''}`}>
            чтение {Math.floor(readMins)}/{READ_MIN_MINUTES} мин
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

      <SectionBlock title="Слова" icon={<Bolt size={18} />} badge="badge-blue" glyph="var(--rune-ansuz)" cards={rw} budget={budgetRw} extraBudget={extraRw} onStart={go('rw')} onReview={go('rw', true)} onExtra={goExtra('rw')} levelLine={levelLine} onPath={() => setScreen('path')} />
      <SectionBlock title="Грамматика" icon={<span className="sec-x">¶</span>} badge="badge-green" glyph="var(--rune-ansuz)" cards={grammar} budget={budgetGrammar} extraBudget={extraGrammar} onStart={go('grammar')} onReview={go('grammar', true)} onExtra={goExtra('grammar')} />
      <SectionBlock title="Математика" icon={<span className="sec-x">∑</span>} badge="badge-purple" glyph="var(--rune-tiwaz)" cards={math} budget={budgetMath} extraBudget={extraMath} onStart={go('math')} onReview={go('math', true)} onExtra={goExtra('math')} />
      <ReadingBlock texts={texts} read={readSlugs} level={readLevel} onOpen={() => setScreen('reading')} />

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
