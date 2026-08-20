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
  { name: 'review-mc-answered', q: 'demo&screen=review&v=mc', clicks: ['.mc-option'] },
  { name: 'review-why', q: 'demo&screen=review&v=mc', clicks: ['.mc-option', '.why-btn'], await: '.why-text' },
  { name: 'review-new', q: 'demo&screen=review&v=new', clicks: ['.btn-green'] },
  { name: 'summary', q: 'demo&screen=summary' },
  { name: 'stats', q: 'demo&screen=stats' },
  { name: 'add', q: 'demo&screen=add' },
  { name: 'welcome', q: 'demo&screen=settings' }
]

/* Разбор «Почему?» ходит в очередь нарядов, откуда его пишет Claude Code на
   домашней машине. Для скриншотов ответ подменяется: снимок не должен зависеть
   от того, включён ли компьютер, — а путь при этом остаётся настоящим, тот же
   заказ и тот же опрос готовности, что в бою.
   Заголовки CORS обязательны: запрос кросс-доменный и с нестандартными
   заголовками, без разрешения браузер отбросит ответ как обрыв сети. */
const РАЗБОР = 'Оба слова про поддержку, но corroborate — про подтверждение фактами, а bolster — про усиление того, что и так стоит. Здесь подлежащее «New fossil evidence»: свидетельства именно подтверждают гипотезу, а не делают её крепче. Bolster был бы уместен там, где укрепляют позицию или уверенность: the discovery bolstered her confidence in the theory.'
const ОЧЕРЕДЬ = 'https://shturman.vault-78edd5.workers.dev/why'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
}

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new'
})
const page = await browser.newPage()
await page.setViewport(viewport)
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])

await page.setRequestInterception(true)
page.on('request', r => {
  if (!r.url().startsWith(ОЧЕРЕДЬ)) { r.continue(); return }
  if (r.method() === 'OPTIONS') { r.respond({ status: 204, headers: CORS }); return }
  // Заказ принят, машина ещё пишет; следующий же опрос отдаёт готовый разбор —
  // так в кадр попадает и строка ожидания, и сам текст.
  const тело = r.method() === 'POST'
    ? { ok: true, id: 'why:demo', state: 'pending', pcAgo: 2 }
    : { ok: true, id: 'why:demo', state: 'done', text: РАЗБОР, pcAgo: 2 }
  r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(тело) })
})

for (const s of shots) {
  await page.goto(`${base}?${s.q}`, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => !document.querySelector('.boot'), { timeout: 10000 })
  await new Promise(r => setTimeout(r, 700)) // settle-анимации
  for (const sel of s.clicks ?? []) {
    const el = await page.$(sel)
    if (el) { await el.click(); await new Promise(r => setTimeout(r, 500)) }
  }
  if (s.await) {
    await page.waitForFunction(sel => (document.querySelector(sel)?.textContent ?? '').length > 50, { timeout: 10000 }, s.await)
    await new Promise(r => setTimeout(r, 900)) // подводка панели к глазам — плавная
  }
  const file = `${s.name}-${sizeArg}-${scheme}.png`
  await page.screenshot({ path: join(out, file) })
  console.log(file)
}
await browser.close()
