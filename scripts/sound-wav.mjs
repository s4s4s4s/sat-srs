/* Рендер звуков урока в WAV — чтобы их можно было послушать, а не только прочитать.
   Использование: node scripts/sound-wav.mjs [outDir]

   Считает не отдельная копия синтеза, а `render` из src/lib/sound.ts, запущенный
   в настоящем Chrome поверх OfflineAudioContext. Иначе проверялось бы не то, что
   звучит в приложении: осцилляторы, фильтр и экспоненциальные огибающие Web Audio
   заново на коленке не воспроизводятся.

   Помимо файлов печатает измерения каждого голоса: длительность, пик и наличие
   срезанных верхушек. Пик у самой границы — уже брак, слышимый как треск. */
import puppeteer from 'puppeteer-core'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? 'sounds'
mkdirSync(out, { recursive: true })

const BUNDLE = 'node_modules/.cache/sat-srs/sound-bundle.js'
mkdirSync('node_modules/.cache/sat-srs', { recursive: true })
execFileSync('npx', ['esbuild', 'src/lib/sound.ts', '--bundle', '--format=iife', '--global-name=SRSSound', `--outfile=${BUNDLE}`], {
  stdio: 'inherit',
  shell: true
})

const SAMPLE_RATE = 44100
/** Хвост после последней ноты: спад огибающей не обрывается на середине. */
const TAIL_SEC = 0.25

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new'
})
const page = await browser.newPage()
await page.addScriptTag({ content: readFileSync(BUNDLE, 'utf8') })

/** Голоса и комбо, под которыми их рендерим: «верно» звучит по-разному в серии. */
const TAKES = [
  { voice: 'intro', combo: 0, name: 'intro' },
  { voice: 'reveal', combo: 0, name: 'reveal' },
  { voice: 'correct', combo: 0, name: 'correct' },
  { voice: 'correct', combo: 3, name: 'correct-series' },
  { voice: 'typo', combo: 0, name: 'typo' },
  { voice: 'wrong', combo: 0, name: 'wrong' },
  { voice: 'streak', combo: 4, name: 'streak' },
  { voice: 'complete', combo: 0, name: 'complete' }
]

const takes = await page.evaluate(async (TAKES, SAMPLE_RATE, TAIL_SEC) => {
  const { score, render, MASTER_GAIN } = window.SRSSound
  const done = []
  for (const t of TAKES) {
    const notes = score(t.voice, t.combo)
    const dur = Math.max(...notes.map(n => n.at + n.dur)) + TAIL_SEC
    const ctx = new OfflineAudioContext(1, Math.ceil(dur * SAMPLE_RATE), SAMPLE_RATE)
    const master = ctx.createGain()
    master.gain.value = MASTER_GAIN
    master.connect(ctx.destination)
    render(ctx, master, t.voice, t.combo, 0)
    const buf = await ctx.startRendering()
    const pcm = Array.from(buf.getChannelData(0))
    let peak = 0
    let clipped = 0
    for (const v of pcm) {
      const a = Math.abs(v)
      if (a > peak) peak = a
      if (a >= 0.999) clipped++
    }
    done.push({ ...t, pcm, peak, clipped, seconds: buf.duration })
  }
  return done
}, TAKES, SAMPLE_RATE, TAIL_SEC)

await browser.close()

/** Моно 16 бит PCM — формат, который открывается чем угодно без кодеков. */
function wav(samples, rate) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)  // PCM
  head.writeUInt16LE(1, 22)  // моно
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

let bad = 0
for (const t of takes) {
  const file = join(out, `${t.name}.wav`)
  writeFileSync(file, wav(t.pcm, SAMPLE_RATE))
  const flag = t.clipped > 0 ? '  ← СРЕЗАНО' : ''
  if (t.clipped > 0) bad++
  console.log(`${t.name.padEnd(15)} ${(t.seconds * 1000).toFixed(0).padStart(5)} мс   пик ${t.peak.toFixed(3)}${flag}`)
}
console.log(`\n${takes.length} файлов в ${out}`)
if (bad > 0) {
  console.error(`${bad} голосов с перегрузом — звук будет трещать`)
  process.exit(1)
}
