/**
 * Звуки урока — синтез на месте, ни одного аудиофайла.
 *
 * Почему синтез, а не сэмплы: приложение обязано работать офлайн и ставиться как PWA,
 * а набор коротких сигналов в mp3 — это лишние сотни килобайт в кэше, чужая лицензия
 * и невозможность подправить звук иначе как перезаписав его. Здесь звук описан
 * партитурой из нескольких нот, и правится числом.
 *
 * Партитура (`score`) — чистая функция без Web Audio: её гоняет `test/sound.test.ts`
 * и по ней же `scripts/sound-wav.mjs` рендерит файлы для прослушивания. Плеер ниже —
 * тонкий слой поверх неё.
 *
 * Все голоса живут в одной тональности (ре-мажорная пентатоника), поэтому два звука,
 * наложившись друг на друга, не дают грязи.
 *
 * Капризы платформы: AudioContext рождается приостановленным и оживает только внутри
 * жеста пользователя (iOS, и Chrome с политикой автовоспроизведения) — отсюда
 * одноразовые слушатели в конце файла. После сворачивания вкладки контекст засыпает
 * снова, поэтому resume() дёргается и перед каждым воспроизведением.
 */

export type Voice = 'correct' | 'typo' | 'wrong' | 'reveal' | 'intro' | 'streak' | 'complete'

/** Одна нота партитуры: времена — секунды от начала голоса, частоты — герцы. */
export interface Note {
  /** сдвиг от начала голоса */
  at: number
  /** полная длительность вместе с затуханием */
  dur: number
  freq: number
  /** куда съезжает частота к концу ноты (глиссандо); нет — нота держит высоту */
  glide?: number
  wave: OscillatorType
  /** пик огибающей до общего регулятора громкости, 0..1 */
  gain: number
  /** время атаки; по умолчанию мгновенная, но не нулевая — нулевая даёт щелчок */
  attack?: number
  /** частота среза ФНЧ; без неё фильтр не ставится */
  cutoff?: number
}

/**
 * Общий регулятор: партитуры пишутся в своих долях, громкость приложения — здесь.
 * 0.8 подобрано по замеру `scripts/sound-wav.mjs`: пик рендера садится на −10 dBFS.
 * Тише — сигнал теряется в метро и на улице, громче — короткий звон бьёт по ушам
 * при ответе за ответом. Экспортируется, чтобы офлайн-рендер звучал как приложение.
 */
export const MASTER_GAIN = 0.8

const DEFAULT_ATTACK = 0.005

/** Частота по номеру MIDI (69 = ля первой октавы, 440 Гц). */
export function hz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/** Ре второй октавы: низ рабочего диапазона сигналов — выше речи и ниже писка. */
const ROOT = 74
/** Ре-мажорная пентатоника в полутонах от тоники: ре, ми, фа-диез, ля, си. */
const PENT = [0, 2, 4, 7, 9]

/** Ступень пентатоники от тоники: 0 — ре, 5 — оно же октавой выше, −5 — октавой ниже. */
export function step(n: number): number {
  const octave = Math.floor(n / PENT.length)
  const degree = n - octave * PENT.length
  return ROOT + 12 * octave + PENT[degree]
}

/**
 * Верный ответ поднимается на ступень с каждым ответом подряд — награда слышимо растёт.
 * Потолок в три ступени не украшение: выше начинается писк, который на четвёртом
 * повторе подряд раздражает, а не радует.
 */
const CORRECT_LIFT_CAP = 3

/** Партитура голоса. `combo` — сколько верных ответов подряд уже было до этого. */
export function score(voice: Voice, combo = 0): Note[] {
  switch (voice) {
    case 'correct': {
      const lift = Math.min(Math.max(combo, 0), CORRECT_LIFT_CAP)
      const low = hz(step(3 + lift))
      const high = hz(step(5 + lift))
      // высокое звучит громче при той же амплитуде — компенсируем подъём
      const g = 0.34 - lift * 0.03
      return [
        { at: 0, dur: 0.14, freq: low, wave: 'triangle', gain: g, attack: 0.004 },
        { at: 0.075, dur: 0.30, freq: high, wave: 'triangle', gain: g, attack: 0.004 },
        // октавный призвук делает из пищалки колокольчик
        { at: 0.075, dur: 0.26, freq: high * 2, wave: 'sine', gain: g * 0.28, attack: 0.006 }
      ]
    }
    case 'typo':
      // «почти»: шаг вниз без разрешения — не награда и не наказание
      return [
        { at: 0, dur: 0.11, freq: hz(step(3)), wave: 'triangle', gain: 0.26, attack: 0.004, cutoff: 2800 },
        { at: 0.10, dur: 0.20, freq: hz(step(2)), wave: 'triangle', gain: 0.22, attack: 0.004, cutoff: 2800 }
      ]
    case 'wrong':
      // низко, мягко и коротко: ошибка на повторении — рабочий момент, а не провал.
      // ФНЧ снимает призвуки, из-за которых сигнал ошибки читается как зуммер
      return [
        { at: 0, dur: 0.20, freq: hz(62), wave: 'sine', gain: 0.34, attack: 0.006, cutoff: 900 },
        { at: 0.10, dur: 0.34, freq: hz(57), wave: 'sine', gain: 0.32, attack: 0.008, cutoff: 900 },
        { at: 0.10, dur: 0.28, freq: hz(57), wave: 'triangle', gain: 0.10, attack: 0.008, cutoff: 700 }
      ]
    case 'reveal':
      // «показать ответ» — щелчок переворота карточки, тише всего остального
      return [
        { at: 0, dur: 0.07, freq: hz(step(4)), glide: hz(step(2)), wave: 'sine', gain: 0.18, attack: 0.003 }
      ]
    case 'intro':
      // знакомство с новым словом: подъём с мягкой атакой, воздушный, без удара
      return [
        { at: 0, dur: 0.30, freq: hz(step(0)), glide: hz(step(5)), wave: 'triangle', gain: 0.22, attack: 0.03, cutoff: 3000 },
        { at: 0.06, dur: 0.34, freq: hz(step(5)), wave: 'sine', gain: 0.12, attack: 0.08 }
      ]
    case 'streak':
      // веха серии: три ступени вверх и октавная искра сверху
      return [
        { at: 0, dur: 0.12, freq: hz(step(3)), wave: 'triangle', gain: 0.28, attack: 0.004 },
        { at: 0.06, dur: 0.12, freq: hz(step(5)), wave: 'triangle', gain: 0.28, attack: 0.004 },
        { at: 0.12, dur: 0.34, freq: hz(step(7)), wave: 'triangle', gain: 0.28, attack: 0.004 },
        { at: 0.12, dur: 0.30, freq: hz(step(7)) * 2, wave: 'sine', gain: 0.10, attack: 0.01 }
      ]
    case 'complete': {
      // урок дошёл до конца: арпеджио тоники и выдержанный аккорд с искрой
      const arp: Note[] = [0, 2, 3, 5].map((s, i) => ({
        at: i * 0.085,
        dur: 0.26,
        freq: hz(step(s)),
        wave: 'triangle' as OscillatorType,
        gain: 0.30,
        attack: 0.004
      }))
      return [
        ...arp,
        { at: 0.34, dur: 0.90, freq: hz(step(5)), wave: 'triangle', gain: 0.18, attack: 0.02 },
        { at: 0.34, dur: 0.90, freq: hz(step(7)), wave: 'sine', gain: 0.14, attack: 0.03 },
        { at: 0.36, dur: 0.80, freq: hz(step(10)), wave: 'sine', gain: 0.09, attack: 0.05 }
      ]
    }
  }
}

/** Все голоса — для тестов и для рендера файлов на прослушивание. */
export const VOICES: Voice[] = ['correct', 'typo', 'wrong', 'reveal', 'intro', 'streak', 'complete']

// ── плеер ───────────────────────────────────────────────────────────────────

type AudioContextCtor = typeof AudioContext

let ctx: AudioContext | null = null
let master: GainNode | null = null
let enabled = true
let unavailable = false

function audio(): AudioContext | null {
  if (unavailable || typeof window === 'undefined') return null
  if (ctx) return ctx
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
  if (!Ctor) { unavailable = true; return null }
  try {
    ctx = new Ctor()
    master = ctx.createGain()
    master.gain.value = MASTER_GAIN
    master.connect(ctx.destination)
    return ctx
  } catch {
    unavailable = true // контекст запрещён политикой браузера — приложение работает молча
    return null
  }
}

/** Включить или выключить звуки. Зовётся из store при загрузке и сохранении настроек. */
export function setSoundEnabled(on: boolean) {
  enabled = on
}

export function soundEnabled(): boolean {
  return enabled
}

/**
 * Разбудить звук из жеста пользователя. Отдельная функция, а не только слушатели ниже:
 * первый же тап по экрану урока должен успеть оживить контекст до первого сигнала.
 */
export function primeAudio() {
  const c = audio()
  if (c && c.state === 'suspended') void c.resume().catch(() => {})
}

function schedule(c: BaseAudioContext, out: AudioNode, n: Note, t0: number) {
  const start = t0 + n.at
  const attack = Math.min(n.attack ?? DEFAULT_ATTACK, n.dur * 0.5)
  const osc = c.createOscillator()
  osc.type = n.wave
  osc.frequency.setValueAtTime(n.freq, start)
  if (n.glide !== undefined) osc.frequency.exponentialRampToValueAtTime(n.glide, start + n.dur)

  const env = c.createGain()
  // экспонента не умеет в ноль — отсюда 0.0001 по краям; линейный спад звучит обрубленно
  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(n.gain, start + attack)
  env.gain.exponentialRampToValueAtTime(0.0001, start + n.dur)

  if (n.cutoff !== undefined) {
    const lp = c.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(n.cutoff, start)
    osc.connect(lp).connect(env).connect(out)
  } else {
    osc.connect(env).connect(out)
  }

  osc.start(start)
  osc.stop(start + n.dur + 0.02)
}

/**
 * Расписать голос в любой аудиоконтекст, начиная с момента `at`.
 * Отдельно от `play`, потому что тем же кодом рендерятся файлы на прослушивание
 * (`scripts/sound-wav.mjs`) — иначе проверять пришлось бы не то, что звучит.
 */
export function render(c: BaseAudioContext, out: AudioNode, voice: Voice, combo = 0, at = 0) {
  for (const n of score(voice, combo)) schedule(c, out, n, at)
}

/** Сыграть голос. Молча ничего не делает, если звук выключен или недоступен. */
export function play(voice: Voice, combo = 0) {
  if (!enabled) return
  const c = audio()
  if (!c || !master) return
  if (c.state === 'suspended') void c.resume().catch(() => {})
  // небольшой отступ от «сейчас»: планировщик Web Audio не любит ноты в прошлом
  render(c, master, voice, combo, c.currentTime + 0.01)
}

if (typeof window !== 'undefined') {
  const wake = () => primeAudio()
  for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) {
    window.addEventListener(ev, wake, { once: true, passive: true })
  }
}
