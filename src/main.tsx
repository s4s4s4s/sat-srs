import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './styles.css'
import App from './App'
import { init } from './lib/store'

// высота экранной клавиатуры в --kb: нижние кнопки поднимаются над ней, а при
// закрытой клавиатуре остаются внизу (VisualViewport надёжнее dvh на iOS Safari)
const vv = window.visualViewport
if (vv) {
  const setKb = () => {
    // innerHeight на iOS не меняется при открытии клавиатуры, vv.height — уменьшается:
    // разница = вся занятая область (клавиатура + панель-тулбар). +8px зазор.
    const occ = window.innerHeight - vv.height
    const kb = occ > 60 ? occ + 8 : 0
    document.documentElement.style.setProperty('--kb', `${kb}px`)
  }
  vv.addEventListener('resize', setKb)
  vv.addEventListener('scroll', setKb)
  setKb()
}

// workbox-window перезагрузит страницу, когда новый SW заберёт контроль — деплой виден с первого запуска
registerSW({
  immediate: true,
  onRegisteredSW(_url, r) {
    if (!r) return
    setInterval(() => void r.update(), 60 * 60 * 1000)
    // каждый разворот приложения — проверка обновления (протухшие билды ловились дважды)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void r.update()
    })
  }
})

void (async () => {
  if (import.meta.env.DEV) {
    const { maybeDemo, demoSession } = await import('./lib/demo')
    const demo = await maybeDemo()
    const { init: initStore, setScreen, finishSession, startLesson } = await import('./lib/store')
    await initStore()
    if (demo?.screen === 'summary') await finishSession(demoSession())
    else if (demo?.screen === 'review') startLesson(demo.section)
    else if (demo?.screen) setScreen(demo.screen as any)
    return
  }
  await init()
})()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
