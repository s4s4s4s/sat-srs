import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

/** Иконка: зелёный скруглённый квадрат + фирменное двухтоновое пламя + SAT */
const svg = (pad) => `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#61d800"/>
      <stop offset="1" stop-color="#45a302"/>
    </linearGradient>
  </defs>
  <rect x="${pad}" y="${pad}" width="${512 - 2 * pad}" height="${512 - 2 * pad}" rx="${pad > 0 ? 110 : 0}" fill="url(#bg)"/>
  <g transform="translate(256 196) scale(2.55) translate(-60 -70)">
    <path d="M60 6C60 6 22 47 22 84C22 111 39 130 60 130C81 130 98 111 98 84C98 47 60 6 60 6Z" fill="#ff9600"/>
    <path d="M60 52C60 52 38 74 38 95C38 111 48 122 60 122C72 122 82 111 82 95C82 74 60 52 60 52Z" fill="#ffc800"/>
    <path d="M34 66 C24 62 18 52 20 42 C28 46 34 54 36 62 Z" fill="#e8e0d0"/>
    <path d="M86 66 C96 62 102 52 100 42 C92 46 86 54 84 62 Z" fill="#e8e0d0"/>
    <path d="M36 72 C36 56 46 46 60 46 C74 46 84 56 84 72 Z" fill="#77879a"/>
    <rect x="33" y="69" width="54" height="8" rx="4" fill="#4a5763"/>
    <path d="M60 52 V66 M60 55 L66 59 M60 61 L66 65" stroke="#d9dfe6" stroke-width="2.2" stroke-linecap="round" fill="none"/>
    <rect x="47" y="80" width="7" height="13" rx="3.5" fill="#7a3d00"/>
    <rect x="66" y="80" width="7" height="13" rx="3.5" fill="#7a3d00"/>
    <path d="M50 104 Q60 114 70 104" stroke="#7a3d00" stroke-width="4" stroke-linecap="round" fill="none"/>
  </g>
  <text x="256" y="452" font-family="Arial, sans-serif" font-size="88" font-weight="900" fill="#ffffff" text-anchor="middle" letter-spacing="6">SAT</text>
</svg>`

mkdirSync('public', { recursive: true })

const jobs = [
  ['public/icon-512.png', svg(24), 512],
  ['public/icon-512-maskable.png', svg(0), 512],
  ['public/icon-192.png', svg(24), 192],
  ['public/apple-touch-icon.png', svg(0), 180],
  ['public/favicon-32.png', svg(0), 32]
]

for (const [out, s, size] of jobs) {
  await sharp(Buffer.from(s)).resize(size, size).png().toFile(out)
  console.log(out)
}
