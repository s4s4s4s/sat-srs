import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './',
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
        start_url: '.',
        scope: '.',
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
