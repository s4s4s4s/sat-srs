import { useState } from 'react'
import { useApp, saveSettings, setScreen, startSync } from '../lib/store'
import { GitHubClient } from '../lib/github'
import { DEFAULT_SETTINGS } from '../lib/types'

const isIosBrowserTab = /iP(hone|ad|od)/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches

export default function SettingsScreen() {
  const app = useApp()
  const [s, setS] = useState({ ...app.settings })
  const [newPerDayStr, setNewPerDayStr] = useState(String(app.settings.newPerDay))
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const firstRun = !app.settings.pat

  const set = (k: 'pat' | 'owner' | 'repo' | 'branch' | 'basePath') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setS({ ...s, [k]: e.target.value })

  async function connect() {
    setErr('')
    setMsg('')
    const basePath = s.basePath.trim().replace(/\/+$/, '')
    if (!basePath) {
      setErr('Укажите папку карточек.')
      return
    }
    const n = Number(newPerDayStr.trim())
    if (!newPerDayStr.trim() || !Number.isFinite(n) || n < 0) {
      setErr('«Новых в день» — число от 0 до 100.')
      return
    }
    const next = {
      ...s,
      pat: s.pat.trim(),
      owner: s.owner.trim(),
      repo: s.repo.trim(),
      branch: s.branch.trim(),
      basePath,
      newPerDay: Math.min(100, Math.round(n)),
      requestRetention: s.requestRetention || DEFAULT_SETTINGS.requestRetention
    }
    if (!next.pat) {
      setErr('Вставьте токен.')
      return
    }
    const a = app.settings
    const connChanged = next.pat !== a.pat || next.owner !== a.owner || next.repo !== a.repo || next.branch !== a.branch
    if (!connChanged) {
      // локальные настройки сохраняются без сети — приложение офлайн-первое
      saveSettings(next)
      setScreen('home')
      return
    }
    setBusy(true)
    try {
      const gh = new GitHubClient(next.pat, next.owner, next.repo)
      await gh.checkRepo()
      await gh.getHead(next.branch)
      saveSettings(next)
      setMsg('Подключено ✓ Загружаю карточки…')
      await startSync()
      setScreen('home')
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen">
      <div className="topbar">
        {!firstRun && <button className="iconbtn" onClick={() => setScreen('home')} aria-label="Назад">←</button>}
        <h2 className="sec" style={{ margin: 0 }}>{firstRun ? 'Подключение' : 'Настройки'}</h2>
      </div>

      {firstRun && isIosBrowserTab && (
        <div className="panel settings-help" style={{ marginBottom: 14, borderColor: 'var(--yellow)' }}>
          <b>Сначала установите приложение:</b> Поделиться → «На экран “Домой”» — и настраивайте уже из него.
          Вкладка Safari и установленное приложение на iPhone не делят хранилище: настройка здесь не перенесётся.
        </div>
      )}

      {firstRun && (
        <div className="panel settings-help" style={{ marginBottom: 14 }}>
          Карточки живут в вашем GitHub-репозитории (vault Obsidian). Нужен fine-grained токен:
          <ol>
            <li>github.com → Settings → Developer settings → <b>Fine-grained tokens</b> → Generate new token</li>
            <li>Repository access: <b>Only select repositories</b> → {s.repo}</li>
            <li>Permissions → Repository → <b>Contents: Read and write</b></li>
            <li>Скопируйте токен и вставьте сюда</li>
          </ol>
          Токен хранится только на этом устройстве.
        </div>
      )}

      <div className="field">
        <label>GitHub-токен *</label>
        <input type="password" value={s.pat} onChange={set('pat')} placeholder="github_pat_…" autoCapitalize="none" autoComplete="off" />
      </div>
      <div className="row">
        <div className="field">
          <label>Владелец</label>
          <input value={s.owner} onChange={set('owner')} autoCapitalize="none" />
        </div>
        <div className="field">
          <label>Репозиторий</label>
          <input value={s.repo} onChange={set('repo')} autoCapitalize="none" />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label>Ветка</label>
          <input value={s.branch} onChange={set('branch')} autoCapitalize="none" />
        </div>
        <div className="field">
          <label>Новых в день</label>
          <input inputMode="numeric" value={newPerDayStr} onChange={e => setNewPerDayStr(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Папка карточек</label>
        <input value={s.basePath} onChange={set('basePath')} />
      </div>

      {err && <div className="form-error">{err}</div>}
      {msg && <div className="form-ok">{msg}</div>}

      <button className="btn btn-green" onClick={() => void connect()} disabled={busy}>
        {busy ? 'Проверяю…' : firstRun ? 'Подключить' : 'Сохранить'}
      </button>
      <div className="syncline" style={{ marginTop: 12 }}>FSRS-6 · retention {app.settings.requestRetention} · SAT SRS v0.1</div>
    </div>
  )
}
