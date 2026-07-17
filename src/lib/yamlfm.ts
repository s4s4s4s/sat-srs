import yaml from 'js-yaml'
import { createEmptyCard, type Card as FsrsCard, State } from 'ts-fsrs'
import type { CardRec, CardView } from './types'

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * Разбор md-файла: frontmatter (CORE_SCHEMA — даты остаются строками) + тело как есть.
 * Битый yaml НЕ отбрасывается: body остаётся полным текстом файла и broken=1 —
 * такую карточку нельзя оценивать/писать, иначе push уничтожит чужой frontmatter.
 */
export function parseMd(text: string): { fm: Record<string, any>; body: string; broken?: number } {
  const m = text.match(FM_RE)
  if (!m) return { fm: {}, body: text }
  try {
    const parsed = yaml.load(m[1], { schema: yaml.CORE_SCHEMA })
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { fm: parsed as Record<string, any>, body: text.slice(m[0].length) }
    }
  } catch { /* fallthrough */ }
  return { fm: {}, body: text, broken: 1 }
}

export function serializeMd(fm: Record<string, any>, body: string): string {
  const y = yaml.dump(fm, { lineWidth: -1, schema: yaml.CORE_SCHEMA })
  return `---\n${y}---\n${body}`
}

function toDate(v: any, fallback: Date): Date {
  if (v == null || v === '') return fallback
  const d = v instanceof Date ? v : new Date(String(v))
  return isNaN(d.getTime()) ? fallback : d
}

const STATE_NAMES: Record<string, number> = { new: 0, learning: 1, review: 2, relearning: 3 }

/** fm.fsrs (может отсутствовать/быть неполным/битым после ручной правки) → полноценный ts-fsrs Card. */
export function fsrsFromFm(fm: Record<string, any>): FsrsCard {
  const added = toDate(fm.added, new Date())
  const empty = createEmptyCard(added)
  const f = fm.fsrs
  if (!f || typeof f !== 'object') return empty
  // невалидная пара stability/difficulty роняет ts-fsrs (d<1 || s<S_MIN) — обнуляем обе, FSRS переинициализирует
  let stability = Number(f.stability)
  let difficulty = Number(f.difficulty)
  if (!(difficulty >= 1 && difficulty <= 10) || !(stability >= 0.001)) { stability = 0; difficulty = 0 }
  const rawState = typeof f.state === 'string' ? (STATE_NAMES[f.state.toLowerCase()] ?? Number(f.state)) : Number(f.state)
  return {
    due: toDate(f.due, added),
    stability,
    difficulty,
    elapsed_days: Number(f.elapsed_days) || 0,
    scheduled_days: Number(f.scheduled_days) || 0,
    learning_steps: Number(f.learning_steps) || 0,
    reps: Number(f.reps) || 0,
    lapses: Number(f.lapses) || 0,
    state: ([0, 1, 2, 3].includes(rawState) ? rawState : State.New) as State,
    last_review: f.last_review ? toDate(f.last_review, added) : undefined
  }
}

const round = (n: number) => Math.round(n * 10000) / 10000

/** ts-fsrs Card → сериализуемый fsrs-блок для frontmatter (даты — ISO-строки UTC). */
export function fsrsToFm(c: FsrsCard): Record<string, any> {
  return {
    state: c.state,
    due: c.due.toISOString(),
    stability: round(c.stability),
    difficulty: round(c.difficulty),
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    last_review: c.last_review ? c.last_review.toISOString() : null
  }
}

export function slugFromPath(path: string): string {
  const base = path.split('/').pop() || path
  return base.replace(/\.md$/i, '')
}

export function cardView(rec: CardRec): CardView {
  const fm = rec.fm
  const hasPrep = !!(fm.prep && fm.prep_context)
  const contexts = Array.isArray(fm.contexts) && fm.contexts.length
    ? fm.contexts.map(String)
    : fm.context ? [String(fm.context)] : []
  return {
    path: rec.path,
    slug: slugFromPath(rec.path),
    word: String(fm.word ?? slugFromPath(rec.path)),
    pos: String(fm.pos ?? ''),
    context: contexts[0] ?? '',
    contexts,
    meaning_en: String(fm.meaning_en ?? ''),
    meaning_ru: String(fm.meaning_ru ?? ''),
    roots: String(fm.roots ?? ''),
    source: String(fm.source ?? 'manual'),
    kind: String(fm.kind ?? 'vocab'),
    domain: String(fm.domain ?? ''),
    choices: Array.isArray(fm.choices) ? fm.choices.map(String) : [],
    answerText: String(fm.answer ?? ''),
    explain: String(fm.explain ?? ''),
    suspended: fm.suspended === true || !!rec.broken,
    fsrs: fsrsFromFm(fm),
    prep: hasPrep ? String(fm.prep).trim().toLowerCase() : '',
    prepContext: hasPrep ? String(fm.prep_context) : '',
    fsrsPrep: hasPrep ? fsrsFromKey(fm, 'fsrs_prep') : null
  }
}

/** Как fsrsFromFm, но для произвольного fsrs-блока (fsrs_prep и будущие навыки) */
export function fsrsFromKey(fm: Record<string, any>, key: string): FsrsCard {
  return fsrsFromFm({ added: fm.added, fsrs: fm[key] })
}

/**
 * Слияние при конфликте: удалённая версия файла — база (тьютор мог править текст),
 * наш вклад — только fsrs-блоки и my_sentence (то, чем владеет приложение).
 * fsrs_prep сохраняем лишь пока у карточки есть prep-поля: их удаление тьютором — осознанное.
 */
export function mergeCard(remote: { fm: Record<string, any>; body: string }, local: CardRec): { fm: Record<string, any>; body: string } {
  const fm = { ...remote.fm }
  if (local.fm.fsrs) fm.fsrs = local.fm.fsrs
  if (local.fm.fsrs_prep && fm.prep && fm.prep_context) fm.fsrs_prep = local.fm.fsrs_prep
  if (local.fm.my_sentence) fm.my_sentence = local.fm.my_sentence
  if (local.fm.first_seen && !fm.first_seen) fm.first_seen = local.fm.first_seen
  return { fm, body: remote.body }
}
