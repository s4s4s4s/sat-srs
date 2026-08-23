/**
 * Чистая разметка для экрана практики (Practice.tsx) — без React и без store, тем же приёмом,
 * что и `reading.ts` для экрана чтения: разбор условия и подпись отсутствующего разбора
 * не зависят ни от DOM, ни от базы, и должны прогоняться в node, а не проверяться текстом
 * исходника экрана.
 */
import type { QuestionView } from './types'

/** Один блок разбора условия: абзац прозы или список заметок студента ("- ..."). */
export interface StemBlock { kind: 'p' | 'ul'; lines: string[] }

/**
 * Условие вопроса иногда содержит список заметок студента — строки, начинающиеся с "- ".
 * На настоящем экзамене это буллиты, и читаются они иначе, чем сплошной абзац: разбор на
 * блоки нужен, чтобы список остался списком на экране, а не слился в один текст.
 *
 * Границы блоков — пустая строка (как у абзацев текста для чтения, см. `paragraphs` в
 * reading.ts): блок из одних только строк "- " становится списком, любой другой — абзацем
 * с внутренними переносами, склеенными пробелом.
 */
export function parseStemBlocks(text: string): StemBlock[] {
  return text
    .split(/\n\s*\n/)
    .map(b => b.trim())
    .filter(Boolean)
    .map(block => {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
      const isList = lines.length > 0 && lines.every(l => l.startsWith('- '))
      return isList
        ? { kind: 'ul' as const, lines: lines.map(l => l.slice(2).trim()) }
        : { kind: 'p' as const, lines }
    })
}

/** Разбор ответа — или честное «его нет», если раздела «## Разбор» не было в файле вопроса. */
export function rationaleText(view: QuestionView): string {
  return view.rationale || 'Разбор к этому вопросу пока не написан.'
}
