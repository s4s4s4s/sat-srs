import { useState } from 'react'
import { useApp, saveSettings, setScreen, startSync, fullResync, unsyncedCount } from '../lib/store'
import { GitHubClient } from '../lib/github'
import { DEFAULT_SETTINGS } from '../lib/types'
import { ChevronLeft } from '../components/Icon'
import FlameBuddy from '../components/FlameBuddy'

const isIosBrowserTab = /iP(hone|ad|od)/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches

export default function SettingsScreen() {
  const app = useApp()
  const [s, setS] = useState({ ...app.settings })
  const [newPerDayStr, setNewPerDayStr] = useState(String(app.settings.newPerDay))
  const [newPerLessonStr, setNewPerLessonStr] = useState(String(app.settings.newPerLesson || 3))
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resyncMsg, setResyncMsg] = useState('')
  const [resyncErr, setResyncErr] = useState('')
  const firstRun = !app.settings.pat

  const set = (k: 'pat' | 'owner' | 'repo' | 'branch' | 'basePath' | 'pauseFrom' | 'pauseTo') => (e: React.ChangeEvent<HTMLInputElement>) =>
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
    const nl = Number(newPerLessonStr.trim())
    if (!newPerLessonStr.trim() || !Number.isFinite(nl) || nl < 1) {
      setErr('«Новых за урок» — число от 1 до 10.')
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
      newPerLesson: Math.min(5, Math.round(nl)),
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

  async function resync() {
    setResyncMsg('')
    setResyncErr('')
    setBusy(true)
    try {
      const n = await fullResync()
      setConfirmReset(false)
      setResyncMsg(`Готово: загружено карточек — ${n}.`)
    } catch (e: any) {
      setResyncErr(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen">
      {firstRun ? (
        <div className="welcome">
          <FlameBuddy size={86} mood="happy" />
          <span className="brand">SAT SRS</span>
          <p>Интервальные повторения для 1550+.<br />Карточки живут в вашем Obsidian-vault.</p>
        </div>
      ) : (
        <div className="page-title">
          <button className="iconbtn" onClick={() => setScreen('home')} aria-label="Назад"><ChevronLeft /></button>
          <h2>Настройки</h2>
        </div>
      )}

      {firstRun && isIosBrowserTab && (
        <div className="card settings-help help-warn" style={{ marginBottom: 14 }}>
          <b>Сначала установите приложение:</b> Поделиться → «На экран “Домой”» — и настраивайте уже из него.
          Вкладка Safari и установленное приложение на iPhone не делят хранилище: настройка здесь не перенесётся.
        </div>
      )}

      {firstRun && (
        <div className="card settings-help" style={{ marginBottom: 14 }}>
          Нужен fine-grained токен GitHub:
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
          <label>Папка карточек</label>
          <input value={s.basePath} onChange={set('basePath')} />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label>Новых в день</label>
          <input inputMode="numeric" value={newPerDayStr} onChange={e => setNewPerDayStr(e.target.value)} />
        </div>
        <div className="field">
          <label>Новых за урок</label>
          <input inputMode="numeric" value={newPerLessonStr} onChange={e => setNewPerLessonStr(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label>Пауза с (YYYY-MM-DD)</label>
          <input value={s.pauseFrom} onChange={set('pauseFrom')} placeholder="2026-07-29" autoCapitalize="none" />
        </div>
        <div className="field">
          <label>Пауза по</label>
          <input value={s.pauseTo} onChange={set('pauseTo')} placeholder="2026-08-02" autoCapitalize="none" />
        </div>
      </div>
      <div className="field"><div className="note">Пауза (переезд): серия не рвётся и не растёт, заморозки не тратятся.</div></div>
      <div className="field">
        <label>Учебный пояс</label>
        <select className="sel" value={s.homeOffset} onChange={e => setS({ ...s, homeOffset: e.target.value })}>
          <option value="180">Москва (UTC+3)</option>
          <option value="240">Ереван (UTC+4)</option>
          <option value="">Часы устройства</option>
        </select>
        <div className="note">Фиксирует границу учебного дня (04:00) независимо от часов устройства — важно при кривых часах ПК и переездах.</div>
      </div>

      {err && <div className="form-error">{err}</div>}
      {msg && <div className="form-ok">{msg}</div>}

      <button className="btn btn-green btn-lg" onClick={() => void connect()} disabled={busy}>
        {busy ? 'Проверяю…' : firstRun ? 'Подключить' : 'Сохранить'}
      </button>
      {!firstRun && (
        <div className="card settings-help help-warn" style={{ marginTop: 18 }}>
          <b>Полная пересинхронизация</b>
          <div style={{ margin: '8px 0' }}>
            Стирает локальные данные этого устройства и строит состояние заново из репозитория.
            Нужна, когда приложение показывает не то, что лежит в vault: карточка без <b>fsrs</b>-блока
            в файле снова станет новой. Раньше это требовало переустановки приложения и повторного ввода токена.
          </div>
          {resyncErr && <div className="form-error">{resyncErr}</div>}
          {resyncMsg && <div className="form-ok">{resyncMsg}</div>}
          {!confirmReset ? (
            <button className="btn btn-red" onClick={() => setConfirmReset(true)} disabled={busy}>
              Пересинхронизировать
            </button>
          ) : (
            <>
              <div style={{ margin: '8px 0' }}>
                <b>Точно?</b> Оценки, ещё не уехавшие в GitHub, строки журнала и локальные правки будут
                потеряны — восстановить их будет нельзя.
                {unsyncedCount() > 0 && <> Сейчас не отправлено: <b>{unsyncedCount()}</b>.</>}
                {' '}Всё состояние заново скачается из <b>{app.settings.owner}/{app.settings.repo}</b> (ветка {app.settings.branch}).
                Токен и настройки сохранятся — вводить заново ничего не придётся.
              </div>
              <div className="row">
                <button className="btn btn-red" onClick={() => void resync()} disabled={busy}>
                  {busy ? 'Загружаю…' : 'Стереть и скачать заново'}
                </button>
                <button className="btn btn-white" onClick={() => setConfirmReset(false)} disabled={busy}>Отмена</button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="syncline" style={{ marginTop: 12 }}>
        FSRS-6 · retention {app.settings.requestRetention} · сборка {__BUILD_ID__}
        {app.tokenExpiresAt && <> · токен до {app.tokenExpiresAt.slice(0, 10)}</>}
      </div>
    </div>
  )
}
