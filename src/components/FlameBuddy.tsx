/**
 * Огонёк — маскот приложения. Чистый SVG+CSS: моргает, покачивается как свеча,
 * меняет лицо по настроению. mood: idle | happy | sad | party
 */

import type { ReactElement } from 'react'

export type BuddyMood = 'idle' | 'happy' | 'sad' | 'party'

const MOUTHS: Record<BuddyMood, ReactElement> = {
  idle: <path d="M52 106 Q60 111 68 106" stroke="#7a3d00" strokeWidth="3.5" strokeLinecap="round" fill="none" />,
  happy: <path d="M50 104 Q60 114 70 104" stroke="#7a3d00" strokeWidth="4" strokeLinecap="round" fill="none" />,
  sad: <path d="M51 110 Q60 102 69 110" stroke="#7a3d00" strokeWidth="3.5" strokeLinecap="round" fill="none" />,
  party: <ellipse cx="60" cy="107" rx="8" ry="9" fill="#7a3d00" />
}

export default function FlameBuddy({ size = 96, mood = 'idle' }: { size?: number; mood?: BuddyMood }) {
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
      </defs>
      {/* тень-подложка */}
      <ellipse cx="60" cy="132" rx="30" ry="6" fill="currentColor" opacity=".12" />
      {/* тело-пламя */}
      <path
        d="M60 6C60 6 22 47 22 84C22 111 39 130 60 130C81 130 98 111 98 84C98 47 60 6 60 6Z"
        fill="url(#bd-outer)"
      />
      {/* внутреннее пламя-лицо */}
      <path
        d="M60 52C60 52 38 74 38 95C38 111 48 122 60 122C72 122 82 111 82 95C82 74 60 52 60 52Z"
        fill="url(#bd-inner)"
      />
      {/* викингский шлем */}
      <g className="buddy-helm">
        {/* рога */}
        <path d="M34 66 C24 62 18 52 20 42 C28 46 34 54 36 62 Z" fill="#e8e0d0" stroke="#c9bfa8" strokeWidth="1.5" />
        <path d="M86 66 C96 62 102 52 100 42 C92 46 86 54 84 62 Z" fill="#e8e0d0" stroke="#c9bfa8" strokeWidth="1.5" />
        {/* купол */}
        <path d="M36 72 C36 56 46 46 60 46 C74 46 84 56 84 72 Z" fill="url(#bd-helm)" />
        {/* обод с заклёпками */}
        <rect x="33" y="69" width="54" height="8" rx="4" fill="#4a5763" />
        <circle cx="42" cy="73" r="1.6" fill="#9aa8b6" />
        <circle cx="60" cy="73" r="1.6" fill="#9aa8b6" />
        <circle cx="78" cy="73" r="1.6" fill="#9aa8b6" />
        {/* руна на куполе */}
        <path d="M60 52 V66 M60 55 L66 59 M60 61 L66 65" stroke="#d9dfe6" strokeWidth="2.2" strokeLinecap="round" fill="none" opacity=".85" />
      </g>
      {/* щёчки */}
      {(mood === 'happy' || mood === 'party') && (
        <>
          <circle cx="44" cy="99" r="4.5" fill="#ff8a65" opacity=".55" />
          <circle cx="76" cy="99" r="4.5" fill="#ff8a65" opacity=".55" />
        </>
      )}
      {/* глаза (моргают) */}
      <g className="buddy-eyes">
        {mood === 'sad' ? (
          <>
            <path d="M46 86 Q51 82 56 86" stroke="#7a3d00" strokeWidth="4" strokeLinecap="round" fill="none" />
            <path d="M64 86 Q69 82 74 86" stroke="#7a3d00" strokeWidth="4" strokeLinecap="round" fill="none" />
          </>
        ) : (
          <>
            <rect x="47" y="80" width="7" height="13" rx="3.5" fill="#7a3d00" />
            <rect x="66" y="80" width="7" height="13" rx="3.5" fill="#7a3d00" />
          </>
        )}
      </g>
      {MOUTHS[mood]}
    </svg>
  )
}
