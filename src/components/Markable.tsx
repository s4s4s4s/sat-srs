import { useMemo, type ReactNode } from 'react'
import Tex from './Tex'
import { segmentText, type Segment } from '../lib/reading'

/**
 * Текст, в котором каждое слово — цель для касания: тап отмечает слово как незнакомое,
 * повторный тап отметку снимает (`store.toggleWordMark`).
 *
 * Один компонент на два экрана — чтение и условие упражнения: правило разбиения на слова и
 * предложения обязано быть одним, иначе одно и то же слово попадёт в журнал двумя разными
 * ключами и порог понятности разъедется с подсветкой.
 *
 * Лемму считает ВЫЗЫВАЮЩИЙ (`isMarked`/`onWord` получают кусок целиком): у текста для чтения
 * словарную форму уточняет глоссарий, у карточки глоссария нет вовсе. Знать об этом здесь
 * нечего — компонент рисует, а не решает, что чем является.
 */
interface Props {
  text: string
  /** Отмечено ли сейчас это слово. */
  isMarked: (seg: Extract<Segment, { kind: 'word' }>) => boolean
  onWord: (seg: Extract<Segment, { kind: 'word' }>) => void
  /** Чем рисовать пропуск `___`. Не задан — подчёркивания остаются обычным текстом. */
  blank?: ReactNode
}

export default function Markable({ text, isMarked, onWord, blank }: Props) {
  const blanks = blank !== undefined
  const segments = useMemo(() => segmentText(text, { blanks }), [text, blanks])
  return (
    <>
      {segments.map((s, i) => {
        if (s.kind === 'tex') return <Tex key={i} text={s.text} />
        if (s.kind === 'blank') return <span key={i}>{blank}</span>
        if (s.kind === 'plain') return <span key={i}>{s.text}</span>
        return (
          <span
            key={i}
            className={`mark-word${isMarked(s) ? ' on' : ''}`}
            /* Не кнопка и не role="button" намеренно: в абзаце их сотни, и озвучка
               превратила бы чтение в перечисление кнопок. Тап по слову — жест
               разметки, а не действие формы.
               preventDefault на mousedown держит фокус там, где он был: в упражнении
               под предложением стоит поле ввода ответа, и отметка слова не имеет права
               уводить из него курсор и закрывать клавиатуру. */
            onMouseDown={e => e.preventDefault()}
            onClick={() => onWord(s)}
          >
            {s.text}
          </span>
        )
      })}
    </>
  )
}
