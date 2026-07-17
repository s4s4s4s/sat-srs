import yaml from 'js-yaml'
import { createEmptyCard, type Card as FsrsCard, State } from 'ts-fsrs'
import type { CardRec, CardView } from './types'

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Разбор md-файла: frontmatter (CORE_SCHEMA — даты остаются строками) + тело как есть. */
export function parseMd(text: string): { fm: Record<string, any>; body: string } {
  const m = text.match(FM_RE)
  if (!m) return { fm: {}, body: text }
  let fm: Record<string, any> = {}
  try {
    const parsed = yaml.load(m[1], { schema: yaml.CORE_SCHEMA })
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fm = parsed as Record<string, any>
  } catch {
    // битый yaml — не падаем, файл считается карточкой без метаданных
  }
  return { fm, body: text.slice(m[0].length) }
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

/** fm.fsrs (может отсутствовать/быть неполным) → полноценный ts-fsrs Card. */
export function fsrsFromFm(fm: Record<string, any>): FsrsCard {
  const added = toDate(fm.added, new Date())
  const empty = createEmptyCard(added)
  const f = fm.fsrs
  if (!f || typeof f !== 'object') return empty
  return {
    due: toDate(f.due, added),
    stability: Number(f.stability) || 0,
    difficulty: Number(f.difficulty) || 0,
    elapsed_days: Number(f.elapsed_days) || 0,
    scheduled_days: Number(f.scheduled_days) || 0,
    learning_steps: Number(f.learning_steps) || 0,
    reps: Number(f.reps) || 0,
    lapses: Number(f.lapses) || 0,
    state: ([0, 1, 2, 3].includes(Number(f.state)) ? Number(f.state) : State.New) as State,
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
  return {
    path: rec.path,
    slug: slugFromPath(rec.path),
    word: String(fm.word ?? slugFromPath(rec.path)),
    pos: String(fm.pos ?? ''),
    context: String(fm.context ?? ''),
    meaning_en: String(fm.meaning_en ?? ''),
    meaning_ru: String(fm.meaning_ru ?? ''),
    roots: String(fm.roots ?? ''),
    source: String(fm.source ?? 'manual'),
    suspended: fm.suspended === true,
    fsrs: fsrsFromFm(fm)
  }
}

/**
 * Слияние при конфликте: удалённая версия файла — база (тьютор мог править текст),
 * наш вклад — только fsrs-блок и my_sentence (то, чем владеет приложение).
 */
export function mergeCard(remote: { fm: Record<string, any>; body: string }, local: CardRec): { fm: Record<string, any>; body: string } {
  const fm = { ...remote.fm }
  if (local.fm.fsrs) fm.fsrs = local.fm.fsrs
  if (local.fm.my_sentence) fm.my_sentence = local.fm.my_sentence
  return { fm, body: remote.body }
}
