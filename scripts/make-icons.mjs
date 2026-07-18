import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

/** Иконка: ночной фьорд + огненный ореол за головой + огонёк-викинг + золотые акценты */
const head = (cx, cy, scale, full = true) => `
  <g transform="translate(${cx} ${cy}) scale(${scale}) translate(-60 -78)">
    ${full ? '<ellipse cx="60" cy="86" rx="42" ry="40" fill="#ff9600" opacity=".30"/>' : ''}
    <path d="M60 6C60 6 22 47 22 84C22 111 39 130 60 130C81 130 98 111 98 84C98 47 60 6 60 6Z" fill="#ff9d2e"/>
    <path d="M60 52C60 52 38 74 38 95C38 111 48 122 60 122C72 122 82 111 82 95C82 74 60 52 60 52Z" fill="#ffce55"/>
    ${full ? '<path d="M60 88 C54 95 50 101 50 108 C50 116 54 121 60 121 C66 121 70 116 70 108 C70 101 66 95 60 88 Z" fill="#fff2c4"/>' : ''}
    <path d="M34 66 C24 62 18 52 20 42 C28 46 34 54 36 62 Z" fill="#e8e0d0"/>
    <path d="M86 66 C96 62 102 52 100 42 C92 46 86 54 84 62 Z" fill="#e8e0d0"/>
    ${full ? '<circle cx="20" cy="43" r="3.4" fill="#e6c268"/><circle cx="100" cy="43" r="3.4" fill="#e6c268"/>' : ''}
    <path d="M36 72 C36 56 46 46 60 46 C74 46 84 56 84 72 Z" fill="url(#helm)"/>
    <path d="M60 52 V66 M60 55 L66 59 M60 61 L66 65" stroke="#e6c268" stroke-width="2.4" stroke-linecap="round" fill="none"/>
    <rect x="33" y="68" width="54" height="8" rx="4" fill="#3c4a56"/>
    <rect x="46" y="80" width="8" height="14" rx="4" fill="#4a2400"/>
    <rect x="66" y="80" width="8" height="14" rx="4" fill="#4a2400"/>
    <path d="M50 104 Q60 114 70 104" stroke="#4a2400" stroke-width="4" stroke-linecap="round" fill="none"/>
  </g>`

const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#16303f"/><stop offset="1" stop-color="#0a1015"/>
    </linearGradient>
    <linearGradient id="helm" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#b6c4d2"/><stop offset="1" stop-color="#4e5f70"/>
    </linearGradient>
  </defs>`

/** основная иконка: сцена + голова + подпись; frame=true даёт золотую фаску и ромбы */
const svg = (pad, frame) => `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${defs}
  <rect x="${pad}" y="${pad}" width="${512 - 2 * pad}" height="${512 - 2 * pad}" rx="${pad > 0 ? 110 : 0}" fill="url(#bg)"/>
  <path d="M0 420 L110 340 L210 405 L320 335 L430 400 L512 350 L512 512 L0 512 Z" fill="#0c2130" opacity=".85"/>
  ${head(256, 208, 2.7)}
  <text x="256" y="470" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="82" font-weight="800" fill="#f2f6f8" text-anchor="middle" letter-spacing="4">SAT</text>
  ${frame ? `<rect x="26" y="26" width="460" height="460" rx="96" fill="none" stroke="#e6c268" stroke-opacity=".34" stroke-width="4"/>
  <g fill="#e6c268" opacity=".8"><rect x="250" y="18" width="12" height="12" transform="rotate(45 256 24)"/><rect x="250" y="482" width="12" height="12" transform="rotate(45 256 488)"/><rect x="18" y="250" width="12" height="12" transform="rotate(45 24 256)"/><rect x="482" y="250" width="12" height="12" transform="rotate(45 488 256)"/></g>` : ''}
</svg>`

/** favicon: крупный кроп головы без сцены/текста — читается в 32px */
const svgSmall = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${defs}
  <rect width="512" height="512" fill="url(#bg)"/>
  ${head(256, 262, 3.7, false)}
</svg>`

mkdirSync('public', { recursive: true })

const jobs = [
  ['public/icon-512.png', svg(24, true), 512],
  ['public/icon-512-maskable.png', svg(0, false), 512],
  ['public/icon-192.png', svg(24, false), 192],
  ['public/apple-touch-icon.png', svg(0, false), 180],
  ['public/favicon-32.png', svgSmall, 32]
]

for (const [out, s, size] of jobs) {
  await sharp(Buffer.from(s)).resize(size, size).png().toFile(out)
  console.log(out)
}
