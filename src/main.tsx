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

/**
 * Заход в один тап: `?go=1` открывает урок сразу, минуя главный экран.
 *
 * До иконки и обратно человек ходил ради одной кнопки: тап по иконке → чтение
 * сводки → тап «Учить». При медианной длине сессии 0,78 минуты навигация
 * занимала заметную долю занятия. `start_url` манифеста теперь `./?go=1`.
 *
 * Условия намеренно узкие: приложение настроено и на сегодня в разделе «Слова»
 * есть что делать. Иначе остаётся витрина — стартовать в пустой урок хуже, чем
 * не стартовать вовсе. Вызывается в ОБЕИХ ветках (dev и прод): иначе заход
 * уезжал бы на телефон ни разу не выполнившись локально.
 */
async function maybeGoStraightToLesson(): Promise<void> {
  const p = new URLSearchParams(location.search)
  if (p.get('go') !== '1') return
  const { views: allViews, startLesson, currentJournal, currentSettings } = await import('./lib/store')
  const { homeCounts, sectionOf } = await import('./lib/scheduler')
  const { newIntroducedOn } = await import('./lib/journal')
  const { dayKey } = await import('./lib/daytime')
  const s = currentSettings()
  if (!s.pat && !import.meta.env.DEV) return
  const rw = allViews().filter(v => sectionOf(v) === 'rw')
  const budget = Math.max(0, s.newPerDay - newIntroducedOn(currentJournal(), dayKey()))
  const c = homeCounts(rw, budget)
  if (c.learnDue + c.revDue + c.newAvail > 0) startLesson('rw', p.get('review') === '1')
}

void (async () => {
  if (import.meta.env.DEV) {
    const { maybeDemo, demoSession } = await import('./lib/demo')
    const demo = await maybeDemo()
    const { init: initStore, setScreen, finishSession, startLesson } = await import('./lib/store')
    await initStore()
    if (demo?.screen === 'summary') await finishSession(demoSession())
    else if (demo?.screen === 'review') startLesson(demo.section)
    else if (demo?.screen) setScreen(demo.screen as any)
    else await maybeGoStraightToLesson()
    return
  }
  await init()
  await maybeGoStraightToLesson()
})()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
