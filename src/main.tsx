import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import '@fontsource/nunito/400.css'
import '@fontsource/nunito/700.css'
import '@fontsource/nunito/800.css'
import './styles.css'
import App from './App'
import { init } from './lib/store'

// workbox-window перезагрузит страницу, когда новый SW заберёт контроль — деплой виден с первого запуска
registerSW({
  immediate: true,
  onRegisteredSW(_url, r) {
    if (r) setInterval(() => void r.update(), 60 * 60 * 1000)
  }
})

void init()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
