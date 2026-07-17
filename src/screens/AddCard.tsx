import { useState } from 'react'
import { addCard, setScreen } from '../lib/store'
import { ChevronLeft } from '../components/Icon'

const EMPTY = { word: '', pos: '', context: '', meaning_ru: '', meaning_en: '', roots: '' }

export default function AddCard() {
  const [f, setF] = useState(EMPTY)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value })

  async function save(stay: boolean) {
    setErr('')
    setOk('')
    if (!f.word.trim() || !f.context.trim() || !f.meaning_ru.trim()) {
      setErr('Нужны минимум: слово, предложение и перевод.')
      return
    }
    let context = f.context.trim()
    if (!/_{3,}/.test(context)) {
      // авто-пропуск: только целое слово (lookaround вместо \b — надёжнее для не-ASCII)
      const esc = f.word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu')
      if (re.test(context)) {
        context = context.replace(re, '______')
      } else {
        setErr('В предложении нет пропуска ______ и нет самого слова — добавьте пропуск.')
        return
      }
    }
    try {
      await addCard({ ...f, context })
    } catch (e: any) {
      setErr(e?.message ?? String(e))
      return
    }
    if (stay) {
      setF(EMPTY)
      setOk(`«${f.word.trim()}» добавлено ✓`)
    } else {
      setScreen('home')
    }
  }

  return (
    <div className="screen">
      <div className="page-title">
        <button className="iconbtn" onClick={() => setScreen('home')} aria-label="Назад"><ChevronLeft /></button>
        <h2>Новое слово</h2>
      </div>

      <div className="field">
        <label>Слово *</label>
        <input value={f.word} onChange={set('word')} placeholder="corroborate" autoCapitalize="none" />
      </div>
      <div className="field">
        <label>Часть речи</label>
        <input value={f.pos} onChange={set('pos')} placeholder="verb / adj / noun" autoCapitalize="none" />
      </div>
      <div className="field">
        <label>Предложение с пропуском *</label>
        <textarea value={f.context} onChange={set('context')} placeholder="New evidence served to ______ the hypothesis…" />
        <div className="note">Пропуск — ______ (если его нет, слово в предложении заменится автоматически)</div>
      </div>
      <div className="field">
        <label>Перевод *</label>
        <input value={f.meaning_ru} onChange={set('meaning_ru')} placeholder="подтверждать (доказательствами)" />
      </div>
      <div className="field">
        <label>Значение (en)</label>
        <input value={f.meaning_en} onChange={set('meaning_en')} placeholder="to confirm or give support to" autoCapitalize="none" />
      </div>
      <div className="field">
        <label>Корни / этимология</label>
        <input value={f.roots} onChange={set('roots')} placeholder="con- (вместе) + robur (сила)" autoCapitalize="none" />
      </div>

      {err && <div className="form-error">{err}</div>}
      {ok && <div className="form-ok">{ok}</div>}

      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn btn-white" onClick={() => void save(true)}>Сохранить, ещё</button>
        <button className="btn btn-green" onClick={() => void save(false)}>Сохранить</button>
      </div>
    </div>
  )
}
