/* Скриншоты всех экранов через установленный Chrome (headless). Использование:
   node scripts/shots.mjs <outDir> [dark|light]  */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? 'shots'
const scheme = process.argv[3] ?? 'dark'
mkdirSync(out, { recursive: true })

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
await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 })
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])

for (const s of shots) {
  await page.goto(`${base}?${s.q}`, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => !document.querySelector('.boot'), { timeout: 10000 })
  await new Promise(r => setTimeout(r, 700)) // settle-анимации
  if (s.click) {
    const el = await page.$(s.click)
    if (el) { await el.click(); await new Promise(r => setTimeout(r, 500)) }
  }
  await page.screenshot({ path: join(out, `${s.name}-${scheme}.png`) })
  console.log(`${s.name}-${scheme}.png`)
}
await browser.close()
