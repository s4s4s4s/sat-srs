/**
 * Тесты партитур звука (src/lib/sound.ts) — чистая часть, без Web Audio.
 *
 * Звук нельзя «посмотреть глазами», поэтому проверяется то, что слышно как брак:
 * писк за пределами приятного диапазона, щелчок из-за нулевой атаки, перегруз
 * от одновременных нот, сигнал длиннее самого ответа и нота мимо тональности.
 * Прослушивание — отдельно: `node scripts/sound-wav.mjs <папка>` рендерит те же
 * партитуры тем же кодом, что играет в приложении.
 *
 * Запуск: `npm run test:sound` (esbuild бандлит файл и node его исполняет).
 */
import { score, hz, VOICES, MASTER_GAIN, type Note, type Voice } from '../src/lib/sound'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

/** Комбо, на которых гоняется каждый голос: ноль, разгон, потолок и заведомо выше него. */
const COMBOS = [0, 1, 2, 3, 4, 12, 99]

function every(fn: (notes: Note[], voice: Voice, combo: number) => void): void {
  for (const v of VOICES) for (const c of COMBOS) fn(score(v, c), v, c)
}

function allFreqs(n: Note): number[] {
  return n.glide === undefined ? [n.freq] : [n.freq, n.glide]
}

// ── S1: голос без нот — это молчание вместо сигнала --------------------------
function notEmpty(): void {
  every((notes, v, c) => assert(notes.length > 0, `${v} при combo=${c} не дал ни одной ноты`))
  group('S1: каждый голос звучит хотя бы одной нотой')
}

// ── S2: диапазон -------------------------------------------------------------
/** Ниже — гул, который на телефонном динамике не воспроизводится; выше — писк. */
const MIN_HZ = 150
const MAX_HZ = 4200

function inRange(): void {
  every((notes, v, c) => {
    for (const n of notes) for (const f of allFreqs(n)) {
      assert(f >= MIN_HZ && f <= MAX_HZ, `${v} при combo=${c}: ${Math.round(f)} Гц вне ${MIN_HZ}–${MAX_HZ}`)
    }
  })
  group('S2: все частоты в рабочем диапазоне — ни гула, ни писка')
}

// ── S3: огибающая ------------------------------------------------------------
function envelopeSane(): void {
  every((notes, v, c) => {
    for (const n of notes) {
      assert(n.dur > 0, `${v}/${c}: нота нулевой длины`)
      assert(n.gain > 0 && n.gain <= 0.5, `${v}/${c}: громкость ноты ${n.gain} вне (0, 0.5]`)
      const attack = n.attack ?? 0.005
      // мгновенная атака даёт щелчок, атака длиннее ноты — сигнал без спада
      assert(attack > 0, `${v}/${c}: нулевая атака — будет щелчок`)
      assert(attack < n.dur, `${v}/${c}: атака ${attack} не короче ноты ${n.dur}`)
      assert(n.at >= 0, `${v}/${c}: нота начинается раньше начала голоса`)
    }
  })
  group('S3: у каждой ноты есть атака и спад — без щелчков')
}

// ── S4: длительность ---------------------------------------------------------
/** Сигнал ответа не должен тянуться в следующий вопрос; фанфаре конца урока — вдвое больше. */
const MAX_MS = 700
const MAX_MS_COMPLETE = 1400

function totalLength(notes: Note[]): number {
  return Math.max(...notes.map(n => n.at + n.dur)) * 1000
}

function shortEnough(): void {
  every((notes, v, c) => {
    const cap = v === 'complete' ? MAX_MS_COMPLETE : MAX_MS
    const len = totalLength(notes)
    assert(len <= cap, `${v}/${c}: ${Math.round(len)} мс при потолке ${cap} мс`)
  })
  group('S4: сигнал короче паузы между вопросами')
}

// ── S5: перегруз -------------------------------------------------------------
/**
 * Наложившиеся ноты складываются амплитудами. Если сумма после общего регулятора
 * переваливает за единицу, звуковая карта срезает верхушки — это слышно как треск.
 */
function noClipping(): void {
  every((notes, v, c) => {
    const edges = notes.flatMap(n => [n.at, n.at + n.dur / 2])
    for (const t of edges) {
      const sum = notes
        .filter(n => t >= n.at && t < n.at + n.dur)
        .reduce((acc, n) => acc + n.gain, 0)
      assert(sum * MASTER_GAIN <= 1, `${v}/${c}: сумма громкостей ${(sum * MASTER_GAIN).toFixed(2)} — перегруз`)
    }
  })
  group('S5: одновременные ноты не дают перегруза')
}

// ── S6: рост награды ---------------------------------------------------------
function comboRises(): void {
  const base = score('correct', 0)[0].freq
  const one = score('correct', 1)[0].freq
  assert(one > base, 'верный ответ подряд не поднял высоту — награда не растёт')

  const cap = score('correct', 3)[0].freq
  assert(score('correct', 12)[0].freq === cap, 'подъём не упёрся в потолок — дальше будет писк')
  assert(score('correct', 99)[0].freq === cap, 'потолок подъёма протекает на больших сериях')

  // и не громче: высокая нота при той же амплитуде воспринимается громче
  assert(score('correct', 3)[0].gain < score('correct', 0)[0].gain,
    'высокая нота серии не приглушена — на потолке сигнал будет резать ухо')
  group('S6: серия поднимает награду и упирается в потолок')
}

// ── S7: тональность ----------------------------------------------------------
/** Ре-мажорная пентатоника в классах высот: ре, ми, фа-диез, ля, си. */
const SCALE = new Set([2, 4, 6, 9, 11])

function midiOf(freq: number): number {
  return Math.round(69 + 12 * Math.log2(freq / 440))
}

function inKey(): void {
  every((notes, v, c) => {
    for (const n of notes) for (const f of allFreqs(n)) {
      const pc = ((midiOf(f) % 12) + 12) % 12
      assert(SCALE.has(pc), `${v}/${c}: ${Math.round(f)} Гц мимо тональности — два звука подряд дадут грязь`)
    }
  })
  group('S7: все ноты в одной тональности — наложения не грязнят')
}

// ── S8: опора нотного ряда ---------------------------------------------------
function tuning(): void {
  assert(Math.abs(hz(69) - 440) < 1e-9, 'ля первой октавы уехало с 440 Гц')
  assert(Math.abs(hz(81) - 880) < 1e-9, 'октава считается неверно')
  group('S8: перевод номера ноты в частоту верен')
}

function main(): void {
  console.log('SRS звук — партитуры голосов: диапазон, огибающая, длительность, перегруз, тональность')
  notEmpty()
  inRange()
  envelopeSane()
  shortEnough()
  noClipping()
  comboRises()
  inKey()
  tuning()
  console.log(`\nВсе проверки звука пройдены (${passed} групп, голосов ${VOICES.length}).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ ЗВУКА УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
