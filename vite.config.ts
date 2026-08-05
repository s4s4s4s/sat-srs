import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' '))
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'favicon-32.png'],
      manifest: {
        name: 'SAT SRS',
        short_name: 'SAT SRS',
        description: 'Интервальные повторения для SAT (FSRS-6)',
        lang: 'ru',
        display: 'standalone',
        /* Иконка открывает урок, а не витрину.
           До главного экрана и обратно человек ходил ради одной кнопки: тап по
           иконке → чтение сводки → тап «Учить». При медианной длине сессии
           0,78 минуты это заметная доля занятия, потраченная на навигацию.
           `?go=1` минует главный экран — см. main.tsx. Витрина остаётся:
           из урока в неё ведёт кнопка «назад». */
        start_url: './?go=1',
        scope: '.',
        shortcuts: [
          { name: 'Заход — слова', short_name: 'Слова', url: './?go=1' },
          { name: 'Только повторить', short_name: 'Повтор', url: './?go=1&review=1' }
        ],
        background_color: '#ffffff',
        theme_color: '#58cc02',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // runtimeCaching не задаём: cross-origin fetch к api.github.com идёт мимо SW,
        // офлайн-слой данных — IndexedDB; SW кэширует только статику приложения
        globPatterns: ['**/*.{js,css,html,png,woff2}']
      }
    })
  ]
})
