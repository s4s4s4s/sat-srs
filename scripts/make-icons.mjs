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
  <g transform="translate(256 210) scale(11.2) translate(-12 -12)">
    <path d="M12 1.8C12 1.8 5.2 8.7 5.2 14.3C5.2 18.4 8.2 21.8 12 21.8C15.8 21.8 18.8 18.4 18.8 14.3C18.8 8.7 12 1.8 12 1.8Z" fill="#ff9600"/>
    <path d="M12 9.8C12 9.8 8.8 13.3 8.8 16C8.8 18 10.2 19.6 12 19.6C13.8 19.6 15.2 18 15.2 16C15.2 13.3 12 9.8 12 9.8Z" fill="#ffc800"/>
  </g>
  <text x="256" y="436" font-family="Arial, sans-serif" font-size="96" font-weight="900" fill="#ffffff" text-anchor="middle" letter-spacing="6">SAT</text>
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
