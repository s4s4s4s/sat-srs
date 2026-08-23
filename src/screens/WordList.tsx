import { useState } from 'react'
import { views, setScreen } from '../lib/store'
import { filterWords, stageCounts, wordStatus, STAGE_ORDER, STAGE_LABEL, type WordStage } from '../lib/wordstatus'
import { ddmm } from '../lib/metrics'
import { ChevronLeft } from '../components/Icon'

/** Перевод обрезается по длине — иначе длинное значение растягивает строку списка
 *  и полоса прогресса справа у соседних слов уезжает вбок. */
const MEANING_MAX = 42

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

/**
 * Экран «Слова»: список всех введённых слов и уровень прогресса по каждому.
 *
 * До 23.08.2026 этого экрана не было — на главной помещалась только сводка (введено/
 * закрепилось), а посмотреть состояние конкретного слова было негде. Список из четырёхсот
 * строк на главный экран не годится, поэтому он вынесен сюда отдельным маршрутом.
 *
 * Отбор и счётчики — целиком через `wordstatus.ts` (`filterWords`, `stageCounts`,
 * `wordStatus`): экран не пересчитывает стадию и не хранит собственную копию правил,
 * иначе список и главная со временем разойдутся в показаниях по одному и тому же слову.
 */
export default function WordList() {
  const all = views()
  const [query, setQuery] = useState('')
  const [stage, setStage] = useState<WordStage | null>(null)
  // раскрыта подробность максимум одного слова — второе открытие первое закрывает
  const [open, setOpen] = useState<string | null>(null)

  const counts = stageCounts(all)
  const countOf = (s: WordStage) => counts.find(c => c.stage === s)?.n ?? 0
  const totalWords = counts.reduce((sum, c) => sum + c.n, 0)
  const list = filterWords(all, query, stage)

  return (
    <div className="screen">
      <div className="page-title">
        <button className="iconbtn" onClick={() => setScreen('home')} aria-label="Назад"><ChevronLeft /></button>
        <h2>Слова</h2>
      </div>

      <div className="field">
        <label htmlFor="word-search">Поиск</label>
        <input
          id="word-search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="слово или перевод"
          autoCapitalize="none"
        />
      </div>

      {/* Чипы стадий не исчезают при n=0 (как и stageCounts) — мигающий ряд кнопок
          заставлял бы искать глазами нужную стадию при каждом открытии экрана. */}
      <div className="stage-chips">
        <button
          type="button"
          className={`stage-chip${stage === null ? ' is-active' : ''}`}
          onClick={() => setStage(null)}
        >
          все <span className="stage-chip-n">{totalWords}</span>
        </button>
        {STAGE_ORDER.map(s => {
          const n = countOf(s)
          return (
            <button
              key={s}
              type="button"
              className={`stage-chip${stage === s ? ' is-active' : ''}`}
              onClick={() => setStage(s)}
              disabled={n === 0}
            >
              {STAGE_LABEL[s]} <span className="stage-chip-n">{n}</span>
            </button>
          )
        })}
      </div>

      {list.length === 0 ? (
        <div className="syncline">ничего не нашлось</div>
      ) : (
        <div className="read-list">
          {list.map(v => {
            const status = wordStatus(v)
            const isOpen = open === v.slug
            return (
              <div key={v.slug}>
                <button
                  type="button"
                  className={`read-item${isOpen ? ' is-now' : ''}`}
                  onClick={() => setOpen(isOpen ? null : v.slug)}
                >
                  <span className="read-item-body">
                    <span className="read-item-title">{v.word}</span>
                    <span className="read-item-sub">{truncate(v.meaning_ru, MEANING_MAX)}</span>
                  </span>
                  <span className="word-stage">
                    <span className="word-stage-label">{STAGE_LABEL[status.stage]}</span>
                    <div className="mastery" title="доля пути до зрелости">
                      <div style={{ width: `${Math.round(status.progress * 100)}%` }} />
                    </div>
                  </span>
                </button>
                {isOpen && (
                  <div className="card word-detail">
                    <div className="syncline">
                      держится {status.stability.toFixed(1)} дн <span className="rsep">·</span> показов {status.reps}
                      {' '}<span className="rsep">·</span> срывов {status.lapses}
                      {/* 999 — принятая в колоде отметка «уровень не назначен» (см. scheduler.ts);
                          показать её числом значило бы выдать служебный код за ступень */}
                      {' '}<span className="rsep">·</span> ступень {v.level >= 999 ? '⚠ не назначена' : v.level}
                    </div>
                    {/* У ещё не введённого слова графика нет: `due` у New — служебная дата,
                        и «следующий повтор» по ней читался бы как назначенный срок */}
                    {status.due && status.stage !== 'new' && (
                      <div className="syncline">следующий повтор {ddmm(status.due)}</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
