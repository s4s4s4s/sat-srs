/** Инлайн SVG-иконки в духе Duolingo: толстые скруглённые штрихи, двухтоновое пламя. */

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function Flame({ size = 24, off = false }: { size?: number; off?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        d="M12 1.8C12 1.8 5.2 8.7 5.2 14.3C5.2 18.4 8.2 21.8 12 21.8C15.8 21.8 18.8 18.4 18.8 14.3C18.8 8.7 12 1.8 12 1.8Z"
        fill={off ? '#d6c9bc' : '#ff9600'}
      />
      <path
        d="M12 9.8C12 9.8 8.8 13.3 8.8 16C8.8 18 10.2 19.6 12 19.6C13.8 19.6 15.2 18 15.2 16C15.2 13.3 12 9.8 12 9.8Z"
        fill={off ? '#c2b3a3' : '#ffc800'}
      />
    </svg>
  )
}

export function Gear({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.6 7.6 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.4z" />
    </svg>
  )
}

export function Chart({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <path d="M5 20V14" />
      <path d="M12 20V4" />
      <path d="M19 20V9" />
    </svg>
  )
}

export function Plus({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function ChevronLeft({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </svg>
  )
}

export function Close({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function Check({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <path d="M4.5 12.5 10 18 19.5 6.5" />
    </svg>
  )
}

export function Bolt({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M13.2 2 5 13.4h5l-1.4 8.6L17 10.6h-5l1.2-8.6Z" fill="currentColor" />
    </svg>
  )
}

export function Sprout({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <path d="M12 21v-8" />
      <path d="M12 13C12 8 8.5 6 4.5 6c0 5 3.5 7 7.5 7z" />
      <path d="M12 11c0-4 3-5.5 7-5.5 0 4.5-3 6.5-7 6.5z" />
    </svg>
  )
}

export function Speaker({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <path d="M11 5.5 6.5 9H3.5v6h3L11 18.5z" fill="currentColor" strokeLinejoin="round" />
      <path d="M15 9.2a4 4 0 0 1 0 5.6" />
      <path d="M17.8 6.5a8 8 0 0 1 0 11" />
    </svg>
  )
}

export function Timer({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9.5V13l2.5 2M9.5 2.5h5" />
    </svg>
  )
}
