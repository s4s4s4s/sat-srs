import { useMemo } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

/** Рендер текста с инлайн-формулами $...$ (KaTeX, локальный бандл — офлайн ок). */

interface Part { s: string; tex?: boolean }

function splitTex(s: string): Part[] {
  const out: Part[] = []
  const re = /\$([^$]+)\$/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ s: s.slice(last, m.index) })
    out.push({ s: m[1], tex: true })
    last = re.lastIndex
  }
  if (last < s.length) out.push({ s: s.slice(last) })
  return out
}

export default function Tex({ text }: { text: string }) {
  const parts = useMemo(() => splitTex(text), [text])
  return (
    <>
      {parts.map((p, i) =>
        p.tex ? (
          <span
            key={i}
            dangerouslySetInnerHTML={{ __html: katex.renderToString(p.s, { throwOnError: false, output: 'html' }) }}
          />
        ) : (
          <span key={i}>{p.s}</span>
        )
      )}
    </>
  )
}
