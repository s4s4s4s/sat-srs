import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

const svg = (pad) => `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect x="${pad}" y="${pad}" width="${512 - 2 * pad}" height="${512 - 2 * pad}" rx="${pad > 0 ? 96 : 0}" fill="#58cc02"/>
  <rect x="${pad + 30}" y="${512 - pad - 118}" width="${512 - 2 * pad - 60}" height="52" rx="26" fill="#46a302"/>
  <text x="256" y="300" font-family="Arial, sans-serif" font-size="150" font-weight="900" fill="#ffffff" text-anchor="middle">SAT</text>
</svg>`

mkdirSync('public', { recursive: true })

const jobs = [
  ['public/icon-512.png', svg(28), 512],
  ['public/icon-512-maskable.png', svg(0), 512],
  ['public/icon-192.png', svg(28), 192],
  ['public/apple-touch-icon.png', svg(0), 180],
  ['public/favicon-32.png', svg(0), 32]
]

for (const [out, s, size] of jobs) {
  await sharp(Buffer.from(s)).resize(size, size).png().toFile(out)
  console.log(out)
}
