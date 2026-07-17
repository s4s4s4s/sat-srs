import type { ReactElement } from 'react'

/**
 * Огонёк-викинг — маскот приложения. Чистый SVG+CSS.
 * mood: idle | happy | sad | party | think
 * На размерах < 56px включается mini-вариант: без микродеталей (заклёпки, руна,
 * тень), толще штрихи — силуэт и лицо читаются даже в 34px.
 */

export type BuddyMood = 'idle' | 'happy' | 'sad' | 'party' | 'think'

function mouth(mood: BuddyMood, mini: boolean): ReactElement {
  const w = mini ? 5 : 3.5
  switch (mood) {
    case 'happy':
      return <path d="M50 104 Q60 114 70 104" stroke="#7a3d00" strokeWidth={mini ? 5.5 : 4} strokeLinecap="round" fill="none" />
    case 'sad':
      return <path d="M51 110 Q60 102 69 110" stroke="#7a3d00" strokeWidth={w} strokeLinecap="round" fill="none" />
    case 'party':
      return <ellipse cx="60" cy="107" rx={mini ? 9 : 8} ry={mini ? 10 : 9} fill="#7a3d00" />
    case 'think':
      return <path d="M53 107 H67" stroke="#7a3d00" strokeWidth={w} strokeLinecap="round" fill="none" />
    default:
      return <path d="M52 106 Q60 111 68 106" stroke="#7a3d00" strokeWidth={w} strokeLinecap="round" fill="none" />
  }
}

export default function FlameBuddy({ size = 96, mood = 'idle' }: { size?: number; mood?: BuddyMood }) {
  const mini = size < 56
  const eyeW = mini ? 8.5 : 7
  return (
    <svg
      width={size}
      height={size * (140 / 120)}
      viewBox="0 0 120 140"
      className={`buddy buddy-${mood}`}
      aria-hidden
    >
      <defs>
        <linearGradient id="bd-outer" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffb020" />
          <stop offset="1" stopColor="#f07300" />
        </linearGradient>
        <linearGradient id="bd-inner" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe066" />
          <stop offset="1" stopColor="#ffc800" />
        </linearGradient>
        <linearGradient id="bd-helm" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9aa8b6" />
          <stop offset="1" stopColor="#5c6b78" />
        </linearGradient>
        <linearGradient id="bd-horn" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#cbbc9d" />
          <stop offset="1" stopColor="#f4edda" />
        </linearGradient>
      </defs>
      {/* тень-подложка (только в крупном) */}
      {!mini && <ellipse cx="60" cy="132" rx="30" ry="6" fill="currentColor" opacity=".12" />}
      {/* тело-пламя */}
      <path
        d="M60 6C60 6 22 47 22 84C22 111 39 130 60 130C81 130 98 111 98 84C98 47 60 6 60 6Z"
        fill="url(#bd-outer)"
      />
      {/* внутреннее пламя-лицо (живёт своей жизнью — лижет воздух) */}
      <path
        className="bd-inner-flame"
        d="M60 52C60 52 38 74 38 95C38 111 48 122 60 122C72 122 82 111 82 95C82 74 60 52 60 52Z"
        fill="url(#bd-inner)"
      />
      {/* викингский шлем */}
      <g className="buddy-helm">
        <path d="M34 66 C24 62 18 52 20 42 C28 46 34 54 36 62 Z" fill="url(#bd-horn)" stroke="#a3936f" strokeWidth={mini ? 2.5 : 2} />
        <path d="M86 66 C96 62 102 52 100 42 C92 46 86 54 84 62 Z" fill="url(#bd-horn)" stroke="#a3936f" strokeWidth={mini ? 2.5 : 2} />
        <path d="M36 72 C36 56 46 46 60 46 C74 46 84 56 84 72 Z" fill="url(#bd-helm)" />
        <rect x="33" y={mini ? 66 : 69} width="54" height={mini ? 6 : 8} rx="3.5" fill="#4a5763" />
        {!mini && (
          <>
            <circle cx="42" cy="73" r="1.6" fill="#9aa8b6" />
            <circle cx="60" cy="73" r="1.6" fill="#9aa8b6" />
            <circle cx="78" cy="73" r="1.6" fill="#9aa8b6" />
            <path d="M60 52 V66 M60 55 L66 59 M60 61 L66 65" stroke="#d9dfe6" strokeWidth="2.2" strokeLinecap="round" fill="none" opacity=".85" />
          </>
        )}
      </g>
      {/* щёчки */}
      {(mood === 'happy' || mood === 'party') && (
        <>
          <circle cx="44" cy="99" r="4.5" fill="#ff8a65" opacity=".55" />
          <circle cx="76" cy="99" r="4.5" fill="#ff8a65" opacity=".55" />
        </>
      )}
      {/* глаза */}
      <g className="buddy-eyes">
        {mood === 'sad' ? (
          <>
            {/* полуприкрытые веки + брови «домиком» — честная грусть, не «зажмурился от счастья» */}
            <rect x={60 - 13 - eyeW / 2} y="84" width={eyeW} height="8" rx="3.5" fill="#7a3d00" />
            <rect x={60 + 13 - eyeW / 2} y="84" width={eyeW} height="8" rx="3.5" fill="#7a3d00" />
            {!mini && <path d="M45 78 L56 81 M75 78 L64 81" stroke="#7a3d00" strokeWidth="3" strokeLinecap="round" fill="none" />}
          </>
        ) : mood === 'think' ? (
          <>
            <rect x={60 - 13 - eyeW / 2} y="79" width={eyeW} height="12" rx="3.5" fill="#7a3d00" />
            <rect x={60 + 13 - eyeW / 2} y="79" width={eyeW} height="12" rx="3.5" fill="#7a3d00" />
            {!mini && <path d="M63 74 Q69 71 75 74" stroke="#7a3d00" strokeWidth="3" strokeLinecap="round" fill="none" />}
          </>
        ) : (
          <>
            <rect x={60 - 13 - eyeW / 2} y="80" width={eyeW} height="13" rx="3.5" fill="#7a3d00" />
            <rect x={60 + 13 - eyeW / 2} y="80" width={eyeW} height="13" rx="3.5" fill="#7a3d00" />
          </>
        )}
        {/* блики — контакт взгляда */}
        {mood !== 'sad' && (
          <>
            <circle cx="49" cy="83.5" r={mini ? 2.2 : 1.7} fill="#ffe9c9" opacity=".9" />
            <circle cx="68" cy="83.5" r={mini ? 2.2 : 1.7} fill="#ffe9c9" opacity=".9" />
          </>
        )}
      </g>
      {mouth(mood, mini)}
    </svg>
  )
}
