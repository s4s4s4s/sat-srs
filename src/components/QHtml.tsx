import { useMemo } from 'react'

/**
 * Разметка вопроса банка College Board (format: html): MathML формул, рисунки (svg/img),
 * таблицы. Файл приходит из колоды, а не из кода приложения, поэтому перед вставкой
 * вычищается всё исполняемое: элементы-скрипты и встраивания, обработчики on*, ссылки
 * javascript:. Формулы рисует сам браузер (MathML Core), без KaTeX: конвертер выгрузки
 * заменяет mfenced, которого MathML Core не знает, на скобки mo.
 */
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form',
  'input', 'button', 'textarea', 'select', 'frame', 'frameset', 'foreignobject'])
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction'])

export function sanitizeHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return ''
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    if (DROP.has(el.localName.toLowerCase())) { el.remove(); continue }
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase()
      if (n.startsWith('on') || (URL_ATTRS.has(n) && /^\s*(javascript|vbscript):/i.test(a.value))) el.removeAttribute(a.name)
    }
  }
  return doc.body.innerHTML
}

export default function QHtml({ html, className, as = 'div' }: { html: string; className?: string; as?: 'div' | 'span' }) {
  const clean = useMemo(() => sanitizeHtml(html), [html])
  const Tag = as
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: clean }} />
}
