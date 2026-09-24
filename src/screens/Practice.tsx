import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, questionViews, logPractice, setScreen, toggleWordMark, openPractice } from '../lib/store'
import {
  pickPractice, practiceStats, practiceDue, moduleQueue, MODULE_BY_SECTION, paceSecOf, practiceVerdict,
  type PracticeFilter
} from '../lib/practice'
import { parseStemBlocks, rationaleText } from '../lib/practiceView'
import { questionSrc } from '../lib/journal'
import { markedLemmas, type Segment } from '../lib/reading'
import Markable from '../components/Markable'
import QHtml from '../components/QHtml'
import { DesmosPanel, DesmosTips } from '../components/Desmos'
import { ChevronLeft, Check, Close } from '../components/Icon'
import type { PracticeSection, QuestionView } from '../lib/types'

/**
 * Практика = настоящие вопросы SAT (`Учёба/Вопросы`) с четырьмя вариантами и разбором.
 *
 * Устройство экрана — тот же приём, что у Reading.tsx: выбор сессии и прохождение вопроса
 * живут в ОДНОМ файле и переключаются локальным `useState`, а не отдельным значением `Screen`.
 * Причина та же — это один и тот же поход («практика»), а не два разных места приложения.
 *
 * Буквы вариантов НЕ перемешиваются: правильный ответ и разбор (`rationale`) в исходном файле
 * говорят «Choice A is the best answer» — привязаны к конкретной букве. Перемешивание вариантов
 * сделало бы разбор ложью, поэтому здесь нет никакой перестановки — они рисуются строго
 * в порядке `view.choices`.
 */

/**
 * Условие вопроса — единственное место, где отметка незнакомого слова разрешена ДО ответа
 * (см. развёрнутый комментарий у `markSrc`/`markWord` ниже). Каждая строка условия и каждая
 * заметка списка проходит через `Markable` независимо: разбор предложений не должен склеивать
 * заметки списка друг с другом.
 */
function Stem({ text, marked, onWord }: {
  text: string
  marked: ReadonlySet<string>
  onWord: (seg: Extract<Segment, { kind: 'word' }>) => void
}) {
  const blocks = useMemo(() => parseStemBlocks(text), [text])
  const isMarked = (seg: Extract<Segment, { kind: 'word' }>) => marked.has(seg.lemma)
  return (
    <div className="prac-stem">
      {blocks.map((b, i) => b.kind === 'ul'
        ? (
          <ul key={i} className="prac-notes">
            {b.lines.map((l, j) => <li key={j}><Markable text={l} isMarked={isMarked} onWord={onWord} /></li>)}
          </ul>
        )
        : <p key={i}><Markable text={b.lines.join(' ')} isMarked={isMarked} onWord={onWord} /></p>)}
    </div>
  )
}

/* ---- один вопрос ------------------------------------------------------------ */

function QuestionScreen({ view, index, total, onExit, onDone, tools }: {
  view: QuestionView
  index: number
  total: number
  onExit: () => void
  onDone: (correct: boolean | null, seconds: number, overPace: boolean) => void
  tools?: React.ReactNode
}) {
  const app = useApp()
  const [picked, setPicked] = useState<QuestionView['choices'][number]['letter'] | null>(null)
  // вписанный ответ SPR (математика): вариантов нет, ответ набирается в поле
  const [typed, setTyped] = useState('')
  const spr = view.kind === 'spr'
  const pace = paceSecOf(view)
  const [confirmed, setConfirmed] = useState(false)
  const shownAt = useRef(Date.now())
  // защита от двойной записи: подтверждение одним тапом уже отсекает случайный ответ на
  // длинном варианте, но повторный рендер того же вопроса не должен писать вторую строку
  const logged = useRef(false)

  /* Мягкий таймер темпа (D5): полоса растёт до paceSecOf(view) (71 с у RW, 95 с у математики,
     MODULE_BY_SECTION) и меняет цвет по истечении, ответ она НЕ блокирует и НЕ засчитывает
     неверным - это единственно честный вариант
     для практики без FSRS, где превышение темпа лишь пишется в журнал строкой `slow`.
     Тик каждую секунду только пока вопрос не подтверждён - после ответа полоса не нужна,
     а таймер и не должен продолжать идти. */
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (confirmed) return
    const id = setInterval(() => forceTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [confirmed, view.path])
  const elapsedSec = (Date.now() - shownAt.current) / 1000
  const overPaceNow = elapsedSec > pace
  const paceWidth = Math.min(100, (elapsedSec / pace) * 100)

  /* Отметка незнакомого слова. Источник — `question:<qid>` (journal.questionSrc): слово из
     настоящего вопроса банка College Board — отдельный сигнал от слова из карточки колоды.
     Ответ на вопрос это не трогает, как и в Review.tsx: очередь сессии собрана заранее и на
     строки журнала не смотрит.

     ГРАНИЦЫ ОТМЕТКИ МЕНЯЮТСЯ С ОТВЕТОМ, и это неочевидно, поэтому явно:
       — ДО подтверждения (`!confirmed`) касание разрешено ТОЛЬКО в условии (Stem). Варианты
         в этот момент — кнопки выбора, и тап по слову внутри них обязан выбирать вариант,
         а не отмечать слово незнакомым: смешать эти два намерения нельзя.
       — ПОСЛЕ подтверждения варианты перестают быть кнопками выбора (ответ уже дан и не
         меняется), поэтому отмечать можно везде — в условии, в тексте вариантов и в разборе. */
  const markSrc = questionSrc(view.qid)
  const marked = useMemo(() => markedLemmas(app.journal, markSrc), [app.journal, markSrc])
  const [markError, setMarkError] = useState('')
  async function markWord(seg: Extract<Segment, { kind: 'word' }>) {
    setMarkError('')
    try {
      await toggleWordMark(markSrc, { word: seg.text, lemma: seg.lemma, sentence: seg.sentence })
    } catch (e) {
      // молчать нельзя: человек уверен, что отметил слово, а его нет ни в журнале, ни у тьютора
      setMarkError(e instanceof Error ? e.message : String(e))
    }
  }
  const isMarked = (seg: Extract<Segment, { kind: 'word' }>) => marked.has(seg.lemma)

  useEffect(() => {
    setPicked(null)
    setTyped('')
    setConfirmed(false)
    logged.current = false
    shownAt.current = Date.now()
    setMarkError('')
  }, [view.path])

  // время и темп фиксируются в момент подтверждения ответа, а не при переходе к следующему
  // вопросу: пока ученик читает разбор, часы бы продолжали идти и завышали темп задним числом
  const answeredSec = useRef(0)
  const answeredOver = useRef(false)

  const chose = spr ? typed.trim() : picked ?? ''
  function confirm() {
    if (!chose || confirmed) return
    setConfirmed(true)
    if (!logged.current) {
      logged.current = true
      const seconds = (Date.now() - shownAt.current) / 1000
      answeredSec.current = seconds
      answeredOver.current = seconds > pace
      void logPractice(view, chose, seconds)
    }
  }

  const verdict = confirmed ? practiceVerdict(view, chose) : null
  const known = spr ? view.answers.length > 0 : !!view.answer
  const correct = confirmed && known ? verdict === true : null

  return (
    <div className="screen s-practice">
      <div className="page-title">
        <button className="iconbtn" onClick={onExit} aria-label="Завершить сессию"><ChevronLeft /></button>
        <h2>Практика · {index + 1}/{total}</h2>
        {tools}
      </div>

      {/* Мягкий темп: полоса растёт до темпа раздела (paceSecOf) и меняет цвет по истечении,
          ответ она не блокирует и не отменяет - таймер только заканчивает экзамен, не отбирает время. */}
      {!confirmed && (
        <div className={`prac-pace${overPaceNow ? ' is-over' : ''}`} aria-hidden="true">
          <div className="prac-pace-fill" style={{ width: `${paceWidth}%` }} />
        </div>
      )}

      <div className="card">
        <div className="prac-meta">{view.skill}{view.difficulty ? ` · ${view.difficulty}` : ''}</div>
        {/* HTML-вопрос (математика: MathML, рисунки, таблицы) рисуется разметкой College Board;
            отметка слова касанием работает только в текстовом вопросе */}
        {view.html
          ? <QHtml className="prac-stem prac-html" html={view.stem} />
          : <Stem text={view.stem} marked={marked} onWord={markWord} />}
      </div>
      {/* Подсказка живёт в обоих состояниях и меняет текст вместе с границами отметки:
          после ответа отмечать можно БОЛЬШЕ, чем до него, и подсказка, исчезающая ровно
          в этот момент, говорила бы обратное. */}
      {!view.html && <div className="read-hint">
        {confirmed
          ? 'Незнакомое слово — коснитесь его: в условии, в вариантах и в разборе'
          : 'Незнакомое слово в условии — коснитесь его'}
      </div>}
      {markError && <div className="why-err">Отметка не сохранилась: {markError}</div>}

      {spr && (
        <input
          className={`type-input prac-spr${confirmed ? (correct ? ' is-right' : known ? ' is-wrong' : '') : ''}`}
          value={typed}
          onChange={e => setTyped(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') confirm() }}
          readOnly={confirmed}
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Ответ: число или дробь, напр. 3/4"
          aria-label="Ответ"
        />
      )}

      {!spr && <div className={`mc-stack${confirmed ? ' answered' : ''}`}>
        {view.choices.map(c => {
          const isPicked = picked === c.letter
          const isRight = confirmed && known && c.letter === view.answer
          const isWrongPick = confirmed && known && isPicked && c.letter !== view.answer
          const cls = [
            'mc-option', 'prac-choice',
            confirmed ? 'mc-static' : '',
            isRight ? 'mc-right' : '',
            isWrongPick ? 'mc-wrong' : '',
            confirmed && !isRight && !isWrongPick ? 'mc-dim' : '',
            !confirmed && isPicked ? 'prac-picked' : ''
          ].filter(Boolean).join(' ')
          const body = (
            <>
              <span className="prac-letter">{c.letter}</span>
              <span className="prac-choice-text">
                {/* до ответа — вариант это кнопка выбора, разметке слово не подлежит (см. комментарий
                    у markSrc/markWord выше); после ответа он статичен, и слово можно отметить */}
                {view.html
                  ? <QHtml as="span" html={c.text} />
                  : confirmed ? <Markable text={c.text} isMarked={isMarked} onWord={markWord} /> : c.text}
              </span>
            </>
          )
          return confirmed ? (
            <div key={c.letter} className={cls}>{body}</div>
          ) : (
            <button
              key={c.letter}
              type="button"
              className={cls}
              onClick={() => setPicked(c.letter)}
            >
              {body}
            </button>
          )
        })}
      </div>}

      {!confirmed ? (
        <button className="btn btn-green btn-lg" onClick={confirm} disabled={!chose}>Ответить</button>
      ) : (
        <div className="card prac-result">
          <div className="hero-head">
            <span className="hero-title prac-result-title">
              {known
                ? correct
                  ? <><Check size={20} /> Верно</>
                  : <><Close size={20} /> Неверно</>
                : 'Ответ принят'}
            </span>
            {known && !correct && <span className="hero-sub">правильный ответ — {spr ? view.answers.join(' или ') : view.answer}</span>}
          </div>
          {view.html && view.rationale
            ? <QHtml className="prac-rationale prac-html" html={view.rationale} />
            : <div className="prac-rationale"><Markable text={rationaleText(view)} isMarked={isMarked} onWord={markWord} /></div>}
          <button className="btn btn-green btn-lg" onClick={() => onDone(correct, answeredSec.current, answeredOver.current)}>
            {index + 1 < total ? 'Следующий вопрос' : 'Итог сессии'}
          </button>
        </div>
      )}
    </div>
  )
}

/* ---- сессия и выбор настроек ------------------------------------------------- */

interface Session {
  queue: QuestionView[]
  idx: number
  answered: number
  correct: number
  mode: 'free' | 'module'
  startedAt: number
  sumSec: number
  overCount: number
}

export default function Practice() {
  const app = useApp()
  const section: PracticeSection = app.practiceSection
  const spec = MODULE_BY_SECTION[section]
  const allViews = questionViews()
  const views = useMemo(() => allViews.filter(v => v.section === section), [allViews, section])
  const mathTotal = useMemo(() => allViews.filter(v => v.section === 'math').length, [allViews])
  const stats = useMemo(() => practiceStats(views, app.journal), [views, app.journal])
  const due = useMemo(() => practiceDue(views, app.journal), [views, app.journal])
  const freshCount = stats.total - stats.solved
  const skills = useMemo(
    () => Array.from(new Set(views.map(v => v.skill).filter(Boolean))).sort(),
    [views]
  )
  const difficulties = useMemo(
    () => Array.from(new Set(views.map(v => v.difficulty).filter(Boolean))).sort(),
    [views]
  )
  const [skill, setSkill] = useState('')
  const [difficulty, setDifficulty] = useState('')
  // фильтр навыка одного раздела другому ни к чему: смена раздела его сбрасывает
  useEffect(() => { setSkill(''); setDifficulty('') }, [section])
  const filter: PracticeFilter = { skill, difficulty }
  const available = useMemo(
    () => pickPractice(views, app.journal, filter),
    [views, app.journal, skill, difficulty]
  )
  const [session, setSession] = useState<Session | null>(null)

  function start(mode: 'free' | 'module') {
    // модуль имитирует настоящий проход RW и не сужается фильтром навыка/сложности -
    // это отдельный режим, а не «начать практику» с предустановленными чипами
    const queue = mode === 'module' ? moduleQueue(views, app.journal, new Date(), section) : available
    if (!queue.length) return
    setSession({ queue, idx: 0, answered: 0, correct: 0, mode, startedAt: Date.now(), sumSec: 0, overCount: 0 })
  }

  function done(correct: boolean | null, seconds: number, overPace: boolean) {
    setSession(s => s && {
      ...s,
      idx: s.idx + 1,
      answered: s.answered + 1,
      correct: s.correct + (correct ? 1 : 0),
      sumSec: s.sumSec + seconds,
      overCount: s.overCount + (overPace ? 1 : 0)
    })
  }

  // счётчик общего бюджета модуля тикает раз в секунду, только пока модуль ещё идёт -
  // это отдельные часы от таймера одного вопроса (PACE_SEC), считающие целиком заход
  const [, forceModuleTick] = useState(0)
  const moduleRunning = !!session && session.mode === 'module' && session.idx < session.queue.length
  useEffect(() => {
    if (!moduleRunning) return
    const id = setInterval(() => forceModuleTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [moduleRunning])
  const moduleElapsedSec = session?.mode === 'module' ? (Date.now() - session.startedAt) / 1000 : 0
  const moduleTimeUp = session?.mode === 'module' && moduleElapsedSec >= spec.seconds

  /* Desmos (математика): тот же калькулятор, что встроен в Bluebook на экзамене. Панель
     монтируется при первом открытии и живёт до конца сессии - скрытая, а не снятая, иначе
     закрытие панели стирало бы построенные графики между вопросами. */
  const [desmosOpen, setDesmosOpen] = useState(false)
  const [desmosMounted, setDesmosMounted] = useState(false)
  useEffect(() => { if (!session) { setDesmosOpen(false); setDesmosMounted(false) } }, [session === null])
  const toggleDesmos = () => { setDesmosMounted(true); setDesmosOpen(o => !o) }

  const running = !!session && session.idx < session.queue.length && !(session.mode === 'module' && moduleTimeUp)
  if (session && running) {
    const remaining = Math.max(0, Math.round(spec.seconds - moduleElapsedSec))
    const math = section === 'math'
    return (
      <div className={`prac-split${desmosOpen ? ' is-open' : ''}`}>
        <div className="prac-main">
          {session.mode === 'module' && (
            <div className="prac-module-clock" aria-live="polite">
              {String(Math.floor(remaining / 60)).padStart(2, '0')}:{String(remaining % 60).padStart(2, '0')} до конца модуля
            </div>
          )}
          <QuestionScreen
            view={session.queue[session.idx]}
            index={session.idx}
            total={session.queue.length}
            onExit={() => setSession(null)}
            onDone={done}
            tools={math ? (
              <button className={`chip desmos-toggle${desmosOpen ? ' is-active' : ''}`} onClick={toggleDesmos} aria-pressed={desmosOpen}>
                Desmos
              </button>
            ) : undefined}
          />
        </div>
        {math && desmosMounted && <DesmosPanel open={desmosOpen} onClose={() => setDesmosOpen(false)} />}
      </div>
    )
  }

  if (session) {
    // сводка модуля (D5): успел ли, точность, среднее время на вопрос, сколько ответов
    // ушло за мягкий бюджет темпа (PACE_SEC) - именно эти четыре числа просит goal WS4
    const finishedAll = session.idx >= session.queue.length
    const accuracy = session.answered ? Math.round((session.correct / session.answered) * 100) : null
    const avgSec = session.answered ? Math.round(session.sumSec / session.answered) : null
    return (
      <div className="screen s-practice">
        <div className="page-title">
          <button className="iconbtn" onClick={() => setSession(null)} aria-label="К настройкам"><ChevronLeft /></button>
          <h2>Итог сессии</h2>
        </div>
        <div className="card sum-wrap">
          <h2 className="sum-title">{session.mode === 'module' ? 'Модуль закончен' : 'Сессия закончена'}</h2>
          {session.mode === 'module' && (
            <div className="sum-sub">
              {finishedAll
                ? `Успел: ${session.answered} из ${session.queue.length}`
                : `Не успел: ${session.answered} из ${session.queue.length} за ${Math.round(spec.seconds / 60)} мин`}
            </div>
          )}
          <div className="sum-sub">
            {session.answered === 0
              ? 'ни один вопрос не отвечен'
              : `${session.correct} из ${session.answered} верно${accuracy !== null ? ` (${accuracy}%)` : ''}`}
          </div>
          {avgSec !== null && (
            <div className="sum-sub">
              среднее время на вопрос: {avgSec} с
              {session.mode === 'module' && ` (за бюджетом ${spec.pace} с: ${session.overCount})`}
            </div>
          )}
          <button className="btn btn-green btn-lg" onClick={() => setSession(null)}>К практике</button>
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <div className="page-title">
        <button className="iconbtn" onClick={() => setScreen('home')} aria-label="Назад"><ChevronLeft /></button>
        <h2>Практика</h2>
      </div>

      {/* Раздел экзамена: вопросы RW и математики - разные очереди, модули и темп */}
      <div className="stage-chips prac-sections">
        <button className={`stage-chip${section === 'rw' ? ' is-active' : ''}`} onClick={() => openPractice('rw')}>Reading & Writing</button>
        <button className={`stage-chip${section === 'math' ? ' is-active' : ''}`} onClick={() => openPractice('math')}>
          Математика{mathTotal ? <span className="stage-chip-n"> · {mathTotal}</span> : null}
        </button>
      </div>
      {section === 'math' && <DesmosTips />}

      {views.length === 0 ? (
        <div className="card"><div className="syncline">
          {section === 'math'
            ? 'Вопросов математики в колоде пока нет: их кладёт выгрузка банка College Board (scripts/qbank-import.mjs).'
            : 'Вопросы появятся после синхронизации с колодой.'}
        </div></div>
      ) : (
        <>
          <div className="card hero hero-slim">
            <div className="hero-head">
              <span className="hero-title">Всего вопросов</span>
              <span className="hero-sub">к повтору {due} · свежих {freshCount}</span>
            </div>
            <div className="minbar-row" style={{ marginTop: 10 }}>
              <div className="minbar"><div style={{ width: `${stats.total ? Math.min(100, (stats.solved / stats.total) * 100) : 0}%` }} /></div>
              <span className="minbar-label">{stats.solved} отвечено</span>
            </div>
            <div className="minbar-row">
              <div className="minbar"><div style={{ width: `${stats.solved ? Math.min(100, (stats.correct / stats.solved) * 100) : 0}%` }} /></div>
              <span className="minbar-label">{stats.correct} верно</span>
            </div>
          </div>

          {skills.length > 0 && (
            <div className="card">
              <div className="prac-filter-label">Навык</div>
              <div className="stage-chips">
                <button
                  className={`stage-chip${skill === '' ? ' is-active' : ''}`}
                  onClick={() => setSkill('')}
                >Любой</button>
                {skills.map(s => {
                  const g = stats.bySkill[s]
                  return (
                    <button
                      key={s}
                      className={`stage-chip${skill === s ? ' is-active' : ''}`}
                      onClick={() => setSkill(s)}
                    >
                      {s}{g ? <span className="stage-chip-n"> · {g.correct}/{g.total}</span> : null}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {difficulties.length > 0 && (
            <div className="card">
              <div className="prac-filter-label">Сложность</div>
              <div className="stage-chips">
                <button
                  className={`stage-chip${difficulty === '' ? ' is-active' : ''}`}
                  onClick={() => setDifficulty('')}
                >Любая</button>
                {difficulties.map(d => (
                  <button
                    key={d}
                    className={`stage-chip${difficulty === d ? ' is-active' : ''}`}
                    onClick={() => setDifficulty(d)}
                  >{d}</button>
                ))}
              </div>
            </div>
          )}

          <button className="btn btn-green btn-lg" onClick={() => start('free')} disabled={available.length === 0}>
            {available.length === 0
              ? 'Под этот фильтр вопросов нет'
              : due > 0 && freshCount === 0
                ? `Повторить · ${due}`
                : `Начать практику · ${available.length}`}
          </button>
          {/* Режим модуля (D5): модуль раздела подряд под общим бюджетом (RW 27 за 32 мин, математика 22 за 35), как модуль
              настоящего цифрового SAT - независимо от чипов навыка/сложности выше. */}
          <button
            className="btn btn-white btn-lg prac-module-btn"
            onClick={() => start('module')}
            disabled={stats.total === 0}
          >
            Режим модуля · {Math.min(spec.questions, stats.total)} вопросов, {Math.round(spec.seconds / 60)} мин
          </button>
        </>
      )}
    </div>
  )
}
