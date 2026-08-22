import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, readingViews, setScreen, toggleWordMark, logTextRead, logReading, currentJournal } from '../lib/store'
import {
  readingSrc, readTextSlugs, markCount, readingPassed, READING_UNKNOWN_SHARE_MAX
} from '../lib/journal'
import { startClock, advance, poke, setActive, flush } from '../lib/readclock'
import { glossFor, lemmaOf, markedLemmas, orderReadings, paragraphs, readingLevel } from '../lib/reading'
import Markable from '../components/Markable'
import { Check, ChevronLeft, Book } from '../components/Icon'
import type { GlossEntry, ReadingView } from '../lib/types'

/** «138 слов» — подпись читается вслух, а не как счётчик (тот же приём, что `упражнений` на главной). */
function слов(n: number): string {
  const ten = n % 100
  const one = n % 10
  return `${n} ${ten >= 11 && ten <= 14 ? 'слов' : one === 1 ? 'слово' : one >= 2 && one <= 4 ? 'слова' : 'слов'}`
}

/**
 * Сколько незнакомых слов текст ещё выдерживает, оставаясь прочитанным самостоятельно.
 *
 * Порог — доля (`READING_UNKNOWN_SHARE_MAX`), и на коротком тексте он честно вырождается в
 * ноль. Говорим это словами: цифра «(0)» на экране читается как сбитый счётчик, а не как
 * «здесь и одно незнакомое слово — уже много».
 */
function допускФраза(words: number): string {
  const n = Math.floor(words * READING_UNKNOWN_SHARE_MAX)
  return n === 0
    ? 'Незнакомых слов этот объём не допускает вовсе.'
    : `Незнакомых слов на этот объём допускается не больше ${n}.`
}

/* ---- сам текст ------------------------------------------------------------ */

interface TapInfo { word: string; gloss: GlossEntry | null }

function TextView({ text, onBack }: { text: ReadingView; onBack: () => void }) {
  const app = useApp()
  const src = readingSrc(text.slug)
  const marked = useMemo(() => markedLemmas(app.journal, src), [app.journal, src])
  const parts = useMemo(() => paragraphs(text.text), [text.text])
  const marks = markCount(app.journal, src)
  /* Сноска показывается только по касанию и только для последнего слова: глоссарий рядом с
     текстом превратил бы чтение в перевод по словарю — ровно то, ради ухода от чего тексты
     и заведены. Снятие отметки закрывает сноску: «я это знаю» и «покажи значение» — разные
     намерения, и держать словарь открытым после первого незачем. */
  const [tap, setTap] = useState<TapInfo | null>(null)
  const [done, setDone] = useState<{ marks: number; passed: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  /* Часы чтения. Живут в ref, а не в состоянии: пересчёт идёт на каждое касание и на
     каждый тик, и рендер на каждую секунду не нужен — на экран уходит только целое
     число минут (`минут`). Сама логика зачёта — в `lib/readclock.ts`, здесь только
     проводка событий браузера. */
  const clock = useRef(startClock(Date.now()))
  const [минут, setМинут] = useState(0)

  /** Записать накопленное строкой журнала. `final` — уход с текста (см. flush). */
  const сдать = useRef(async (final: boolean) => {})
  сдать.current = async (final: boolean) => {
    const { minutes, rest } = flush(clock.current, Date.now(), final)
    clock.current = rest
    if (minutes < 1) return
    // строка пишется в тот же журнал, что и повторы, и уезжает тьютору обычной синхронизацией
    await logReading(minutes, text.title, src)
  }

  useEffect(() => {
    const действие = () => { clock.current = poke(clock.current, Date.now()) }
    const видимость = () => {
      const видно = document.visibilityState === 'visible'
      clock.current = setActive(clock.current, Date.now(), видно)
      // сворачивание приложения — единственный момент, когда размонтирования может не быть
      // вовсе (телефон убивает вкладку), поэтому накопленное сдаётся здесь, а не только в конце
      if (!видно) void сдать.current(false)
    }
    const уход = () => { void сдать.current(true) }
    window.addEventListener('pointerdown', действие, { passive: true })
    window.addEventListener('keydown', действие)
    window.addEventListener('scroll', действие, { passive: true })
    window.addEventListener('wheel', действие, { passive: true })
    document.addEventListener('visibilitychange', видимость)
    window.addEventListener('pagehide', уход)
    const тик = setInterval(() => {
      clock.current = advance(clock.current, Date.now())
      setМинут(Math.floor(clock.current.total / 60))
    }, 5_000)
    return () => {
      clearInterval(тик)
      window.removeEventListener('pointerdown', действие)
      window.removeEventListener('keydown', действие)
      window.removeEventListener('scroll', действие)
      window.removeEventListener('wheel', действие)
      document.removeEventListener('visibilitychange', видимость)
      window.removeEventListener('pagehide', уход)
      void сдать.current(true)
    }
  }, [])

  async function onWord(seg: { text: string; sentence: string }) {
    setErr('')
    try {
      const gloss = glossFor(text.glossary, seg.text)
      const on = await toggleWordMark(src, {
        word: seg.text,
        lemma: lemmaOf(text.glossary, seg.text),
        sentence: seg.sentence
      })
      setTap(on ? { word: seg.text, gloss } : null)
    } catch (e) {
      // отметку не сохранили — молчать нельзя: слово потеряется, а человек будет уверен, что отметил
      setErr(`Отметка не сохранилась: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function finish() {
    setBusy(true)
    setErr('')
    try {
      /* Часы останавливаются ДО записи: время над карточкой «Текст прочитан» — это уже не
         чтение. Секунды всего захода уходят в строку прочтения (темп), минуты — отдельной
         строкой `read` в полосу дня; двойного счёта нет, это разные величины в разных полях. */
      clock.current = setActive(clock.current, Date.now(), false)
      await logTextRead(text, clock.current.total)
      await сдать.current(true)
      // счёт берём из журнала после записи — тем же способом, что и сама строка (logTextRead),
      // чтобы итог на экране не мог разойтись с тем, что уехало тьютору
      const n = markCount(currentJournal(), src)
      setDone({ marks: n, passed: readingPassed(n, text.words) })
      setTap(null)
    } catch (e) {
      setErr(`Прочтение не записалось: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen s-read">
      <div className="page-title">
        <button className="iconbtn" onClick={onBack} aria-label="К списку текстов"><ChevronLeft /></button>
        <h2 className="read-h">{text.title}</h2>
      </div>
      {/* Минуты видны прямо здесь: полоса «чтение 0/30» на главной семь недель стояла
          на нуле, и без счётчика на самом тексте нельзя отличить «не читал» от «читал,
          а приложение не считает» — ровно эта неразличимость и была дефектом. */}
      <div className="read-meta">
        ступень {text.level} <span className="rsep">·</span> {слов(text.words)}
        {' '}<span className="rsep">·</span> отмечено {marks}
        {' '}<span className="rsep">·</span> {минут < 1 ? 'меньше минуты' : `${минут} мин`}
      </div>

      <div className="read-text">
        {parts.map((p, i) => (
          <p key={i} className="read-p">
            <Markable
              text={p}
              isMarked={seg => marked.has(lemmaOf(text.glossary, seg.text))}
              onWord={onWord}
            />
          </p>
        ))}
      </div>

      {marks === 0 && !done && <div className="read-hint">Незнакомое слово — коснитесь его: оно уйдёт тьютору вместе с предложением</div>}
      {err && <div className="syncline err">{err}</div>}

      {done ? (
        <div className="card read-done">
          <div className="hero-head">
            <span className="hero-title">{done.passed ? 'Текст прочитан' : 'Текст оказался тяжеловат'}</span>
            <span className="hero-sub">отмечено {done.marks} из {text.words}</span>
          </div>
          <div className="read-done-sub">
            {допускФраза(text.words)}{' '}
            {done.passed
              ? 'Уложились — это чтение, а не разбор по словарю.'
              : 'Это не провал: следующий текст стоит взять ступенью ниже, а отмеченные слова разберёт тьютор.'}
          </div>
          <button className="btn btn-green section-btn" onClick={onBack}>К списку текстов</button>
        </div>
      ) : (
        <button className="btn btn-green btn-lg read-finish" onClick={() => void finish()} disabled={busy}>
          {busy ? 'Записываю…' : 'Я дочитал'}
        </button>
      )}

      {tap && (
        <div className="read-gloss">
          <button className="read-gloss-x" onClick={() => setTap(null)} aria-label="Закрыть сноску">×</button>
          <div className="read-gloss-word">
            {tap.gloss?.word ?? tap.word}
            {tap.gloss?.pos && <span className="pos">{tap.gloss.pos}</span>}
          </div>
          {tap.gloss ? (
            <>
              {tap.gloss.meaning_ru && <div className="read-gloss-ru">{tap.gloss.meaning_ru}</div>}
              {tap.gloss.meaning_en && <div className="read-gloss-en">{tap.gloss.meaning_en}</div>}
            </>
          ) : (
            <div className="read-gloss-en">Сноски к этому слову нет — слово отмечено, разбор за тьютором.</div>
          )}
        </div>
      )}
    </div>
  )
}

/* ---- список текстов ------------------------------------------------------- */

export default function Reading() {
  const app = useApp()
  const texts = readingViews()
  const read = useMemo(() => readTextSlugs(app.journal), [app.journal])
  const level = readingLevel(texts, read)
  const list = useMemo(() => orderReadings(texts, level), [texts, level])
  /* «Сейчас» помечает ровно один текст — первый непрочитанный на текущей ступени.
     Метка на всей ступени читалась бы как «эти три равнозначны», а на уже прочитанном
     тексте соседствовала бы с пометкой «прочитан» и противоречила ей. */
  const nowSlug = list.find(t => t.level === level && !read.has(t.slug))?.slug ?? ''
  /* Какой текст открыт — состояние экрана, а не приложения: список и текст суть один экран
     чтения, и хранить «где я внутри него» в store значило бы заводить общее состояние ради
     одной кнопки «назад». */
  const [open, setOpen] = useState('')

  const current = list.find(t => t.slug === open)
  if (current) return <TextView text={current} onBack={() => setOpen('')} />

  return (
    <div className="screen">
      <div className="page-title">
        <button className="iconbtn" onClick={() => setScreen('home')} aria-label="Назад"><ChevronLeft /></button>
        <h2>Чтение</h2>
      </div>

      {list.length === 0 ? (
        <div className="card"><div className="syncline">Тексты появятся после синхронизации с колодой.</div></div>
      ) : (
        <div className="read-list">
          {list.map(t => {
            const isRead = read.has(t.slug)
            return (
              <button
                key={t.slug}
                className={`read-item${isRead ? ' is-read' : ''}${t.slug === nowSlug ? ' is-now' : ''}`}
                onClick={() => setOpen(t.slug)}
              >
                <span className="read-lv">{t.level}</span>
                <span className="read-item-body">
                  <span className="read-item-title">
                    {t.title}
                    {t.slug === nowSlug && <span className="path-tag">сейчас</span>}
                  </span>
                  <span className="read-item-sub">{слов(t.words)}{isRead ? ' · прочитан' : ''}</span>
                </span>
                <span className="read-item-mark">{isRead ? <Check size={20} /> : <Book size={20} />}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
