import { useState } from 'react'
import { useApp, saveSettings, setScreen, startSync } from '../lib/store'
import { GitHubClient } from '../lib/github'

export default function SettingsScreen() {
  const app = useApp()
  const [s, setS] = useState({ ...app.settings })
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const firstRun = !app.settings.pat

  const set = (k: keyof typeof s) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setS({ ...s, [k]: k === 'newPerDay' ? Number(e.target.value) : e.target.value })

  async function connect() {
    setErr('')
    setMsg('')
    if (!s.pat.trim()) {
      setErr('Вставьте токен.')
      return
    }
    setBusy(true)
    try {
      const gh = new GitHubClient(s.pat.trim(), s.owner.trim(), s.repo.trim())
      await gh.checkRepo()
      await gh.getHead(s.branch.trim())
      saveSettings({ ...s, pat: s.pat.trim(), owner: s.owner.trim(), repo: s.repo.trim(), branch: s.branch.trim() })
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
          <input type="number" min={0} max={100} value={s.newPerDay} onChange={set('newPerDay')} />
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
