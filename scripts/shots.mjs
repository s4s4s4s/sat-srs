/* Скриншоты всех экранов через установленный Chrome (headless). Использование:
   node scripts/shots.mjs <outDir> [dark|light] [phone|laptop|wide|<ширина>x<высота>]

   Размер обязателен к проверке в обоих концах: у приложения две разные
   раскладки — телефонная лента и ноутбучная сетка (см. медиа-запросы в
   styles.css), и увидеть регресс одной по скриншотам другой нельзя. */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? 'shots'
const scheme = process.argv[3] ?? 'dark'
const sizeArg = process.argv[4] ?? 'phone'
mkdirSync(out, { recursive: true })

/* Пресеты подобраны по границам медиа-запросов: phone — до 720, laptop и
   wide — за 1024, где главный экран и статистика становятся сеткой. */
const PRESETS = {
  phone: { width: 375, height: 812, deviceScaleFactor: 2 },
  laptop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  wide: { width: 1920, height: 1080, deviceScaleFactor: 1 }
}
const custom = /^(\d{3,5})x(\d{3,5})$/.exec(sizeArg)
const viewport = custom
  ? { width: Number(custom[1]), height: Number(custom[2]), deviceScaleFactor: 1 }
  : PRESETS[sizeArg]
if (!viewport) {
  console.error(`неизвестный размер «${sizeArg}»: ожидается ${Object.keys(PRESETS).join(' | ')} или 1280x800`)
  process.exit(1)
}

const base = 'http://localhost:5173/'
const shots = [
  { name: 'home', q: 'demo' },
  { name: 'review-mc', q: 'demo&screen=review&v=mc' },
  { name: 'review-mc-answered', q: 'demo&screen=review&v=mc', click: '.mc-option' },
  { name: 'review-new', q: 'demo&screen=review&v=new', click: '.btn-green' },
  { name: 'summary', q: 'demo&screen=summary' },
  { name: 'stats', q: 'demo&screen=stats' },
  { name: 'add', q: 'demo&screen=add' },
  { name: 'welcome', q: 'demo&screen=settings' }
]

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new'
})
const page = await browser.newPage()
await page.setViewport(viewport)
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])

for (const s of shots) {
  await page.goto(`${base}?${s.q}`, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => !document.querySelector('.boot'), { timeout: 10000 })
  await new Promise(r => setTimeout(r, 700)) // settle-анимации
  if (s.click) {
    const el = await page.$(s.click)
    if (el) { await el.click(); await new Promise(r => setTimeout(r, 500)) }
  }
  const file = `${s.name}-${sizeArg}-${scheme}.png`
  await page.screenshot({ path: join(out, file) })
  console.log(file)
}
await browser.close()
