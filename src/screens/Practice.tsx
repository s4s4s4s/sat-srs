import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, questionViews, logPractice, setScreen, toggleWordMark } from '../lib/store'
import { pickPractice, practiceStats, type PracticeFilter } from '../lib/practice'
import { parseStemBlocks, rationaleText } from '../lib/practiceView'
import { questionSrc } from '../lib/journal'
import { markedLemmas, type Segment } from '../lib/reading'
import Markable from '../components/Markable'
import { ChevronLeft, Check, Close } from '../components/Icon'
import type { QuestionView } from '../lib/types'

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

function QuestionScreen({ view, index, total, onExit, onDone }: {
  view: QuestionView
  index: number
  total: number
  onExit: () => void
  onDone: (correct: boolean | null) => void
}) {
  const app = useApp()
  const [picked, setPicked] = useState<QuestionView['choices'][number]['letter'] | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const shownAt = useRef(Date.now())
  // защита от двойной записи: подтверждение одним тапом уже отсекает случайный ответ на
  // длинном варианте, но повторный рендер того же вопроса не должен писать вторую строку
  const logged = useRef(false)

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
    setConfirmed(false)
    logged.current = false
    shownAt.current = Date.now()
    setMarkError('')
  }, [view.path])

  function confirm() {
    if (!picked || confirmed) return
    setConfirmed(true)
    if (!logged.current) {
      logged.current = true
      const seconds = (Date.now() - shownAt.current) / 1000
      void logPractice(view, picked, seconds)
    }
  }

  const known = !!view.answer
  const correct = confirmed && known ? picked === view.answer : null

  return (
    <div className="screen s-practice">
      <div className="page-title">
        <button className="iconbtn" onClick={onExit} aria-label="Завершить сессию"><ChevronLeft /></button>
        <h2>Практика · {index + 1}/{total}</h2>
      </div>

      <div className="card">
        <div className="prac-meta">{view.skill}{view.difficulty ? ` · ${view.difficulty}` : ''}</div>
        <Stem text={view.stem} marked={marked} onWord={markWord} />
      </div>
      {/* Подсказка живёт в обоих состояниях и меняет текст вместе с границами отметки:
          после ответа отмечать можно БОЛЬШЕ, чем до него, и подсказка, исчезающая ровно
          в этот момент, говорила бы обратное. */}
      <div className="read-hint">
        {confirmed
          ? 'Незнакомое слово — коснитесь его: в условии, в вариантах и в разборе'
          : 'Незнакомое слово в условии — коснитесь его'}
      </div>
      {markError && <div className="why-err">Отметка не сохранилась: {markError}</div>}

      <div className={`mc-stack${confirmed ? ' answered' : ''}`}>
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
                {confirmed ? <Markable text={c.text} isMarked={isMarked} onWord={markWord} /> : c.text}
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
      </div>

      {!confirmed ? (
        <button className="btn btn-green btn-lg" onClick={confirm} disabled={!picked}>Ответить</button>
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
            {known && !correct && <span className="hero-sub">правильный ответ — {view.answer}</span>}
          </div>
          <div className="prac-rationale"><Markable text={rationaleText(view)} isMarked={isMarked} onWord={markWord} /></div>
          <button className="btn btn-green btn-lg" onClick={() => onDone(correct)}>
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
}

export default function Practice() {
  const app = useApp()
  const views = questionViews()
  const stats = useMemo(() => practiceStats(views, app.journal), [views, app.journal])
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
  const filter: PracticeFilter = { skill, difficulty }
  const available = useMemo(
    () => pickPractice(views, app.journal, filter),
    [views, app.journal, skill, difficulty]
  )
  const [session, setSession] = useState<Session | null>(null)

  function start() {
    if (!available.length) return
    setSession({ queue: available, idx: 0, answered: 0, correct: 0 })
  }

  function done(correct: boolean | null) {
    setSession(s => s && {
      queue: s.queue,
      idx: s.idx + 1,
      answered: s.answered + 1,
      correct: s.correct + (correct ? 1 : 0)
    })
  }

  if (session && session.idx < session.queue.length) {
    return (
      <QuestionScreen
        view={session.queue[session.idx]}
        index={session.idx}
        total={session.queue.length}
        onExit={() => setSession(null)}
        onDone={done}
      />
    )
  }

  if (session) {
    return (
      <div className="screen s-practice">
        <div className="page-title">
          <button className="iconbtn" onClick={() => setSession(null)} aria-label="К настройкам"><ChevronLeft /></button>
          <h2>Итог сессии</h2>
        </div>
        <div className="card sum-wrap">
          <h2 className="sum-title">Сессия закончена</h2>
          <div className="sum-sub">
            {session.answered === 0
              ? 'ни один вопрос не отвечен'
              : `${session.correct} из ${session.answered} верно`}
          </div>
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

      {views.length === 0 ? (
        <div className="card"><div className="syncline">Вопросы появятся после синхронизации с колодой.</div></div>
      ) : (
        <>
          <div className="card hero hero-slim">
            <div className="hero-head">
              <span className="hero-title">Всего вопросов</span>
              <span className="hero-sub">{stats.total}</span>
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

          <button className="btn btn-green btn-lg" onClick={start} disabled={available.length === 0}>
            {available.length === 0 ? 'Под этот фильтр вопросов нет' : `Начать практику · ${available.length}`}
          </button>
        </>
      )}
    </div>
  )
}
