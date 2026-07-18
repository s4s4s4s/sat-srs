import { useId } from 'react'
import type { ReactElement } from 'react'

/**
 * Огонёк-викинг v3 — маскот. Чистый SVG+CSS, viewBox 0 0 120 150.
 * Три слоя огня (боковые языки + внутреннее пламя + горячее ядро), кованый шлем,
 * тело «дышит», глаза с двойным бликом. 5 настроений: idle/happy/sad/party/think.
 * mini (<56px): без микродеталей — читается в 34px.
 */

export type BuddyMood = 'idle' | 'happy' | 'sad' | 'party' | 'think'

function mouth(mood: BuddyMood): ReactElement {
  switch (mood) {
    case 'happy':
      return <path d="M49 103 Q60 115 71 103" stroke="#4a2400" strokeWidth="4" strokeLinecap="round" fill="none" />
    case 'sad':
      return <path d="M51 111 Q60 104 69 111" stroke="#4a2400" strokeWidth="3.5" strokeLinecap="round" fill="none" />
    case 'party':
      return <ellipse cx="60" cy="108" rx="8" ry="9" fill="#4a2400" />
    case 'think':
      return <path d="M53 108 H67" stroke="#4a2400" strokeWidth="3.5" strokeLinecap="round" fill="none" />
    default:
      return <path d="M52 106 Q60 112 68 106" stroke="#4a2400" strokeWidth="3.5" strokeLinecap="round" fill="none" />
  }
}

export default function FlameBuddy({ size = 96, mood = 'idle' }: { size?: number; mood?: BuddyMood }) {
  const mini = size < 56
  const uid = useId().replace(/:/g, '')
  const id = (n: string) => `${n}-${uid}`
  const eyeY = mood === 'think' ? 77 : mood === 'sad' ? 85 : 80
  const eyeH = mood === 'sad' ? 9 : 14
  const eyeDx = mood === 'think' ? 2 : 0

  return (
    <svg width={size} height={size * (150 / 120)} viewBox="0 0 120 150" className={`buddy buddy-${mood}`} aria-hidden>
      <defs>
        <linearGradient id={id('outer')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffc14d" /><stop offset="1" stopColor="#ee7207" />
        </linearGradient>
        <linearGradient id={id('inner')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe9a3" /><stop offset="1" stopColor="#ffc23d" />
        </linearGradient>
        <linearGradient id={id('core')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff8dc" /><stop offset="1" stopColor="#ffd76b" />
        </linearGradient>
        <linearGradient id={id('helm')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b6c4d2" /><stop offset="1" stopColor="#4e5f70" />
        </linearGradient>
        <linearGradient id={id('horn')} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#d8ccb0" /><stop offset="1" stopColor="#f2ead6" />
        </linearGradient>
      </defs>

      {!mini && <ellipse cx="60" cy="140" rx="30" ry="6" fill="#000" opacity=".14" />}

      <g className="bd-body">
        {/* боковые языки пламени */}
        {!mini && mood !== 'sad' && (
          <>
            <path className="bd-tongueL" d="M31 50 C24 58 19 69 22 80 C26 71 32 62 36 55 Z" fill={`url(#${id('outer')})`} />
            <path className="bd-tongueR" d="M89 46 C96 54 101 66 98 77 C94 68 88 59 84 52 Z" fill={`url(#${id('outer')})`} />
          </>
        )}
        {/* тело */}
        <path
          d="M60 8 C49 25 28 46 27 80 C26 108 42 130 60 130 C78 130 94 108 93 80 C92 55 76 42 71 26 C69 36 63 40 62 31 C61 22 60.5 14 60 8 Z"
          fill={`url(#${id('outer')})`}
        />
        {/* внутреннее пламя */}
        <path
          className="bd-inner-flame"
          d="M60 56 C50 68 41 81 41 97 C41 112 50 123 60 123 C70 123 79 112 79 97 C79 85 69 73 66 62 C65 68 61 70 60 64 Z"
          fill={`url(#${id('inner')})`}
        />
        {/* горячее ядро */}
        {!mini && mood !== 'sad' && (
          <path
            className="bd-core"
            d="M60 88 C54 95 50 101 50 108 C50 116 54 121 60 121 C66 121 70 116 70 108 C70 101 66 95 60 88 Z"
            fill={`url(#${id('core')})`}
          />
        )}
      </g>

      {/* шлем */}
      <g className="buddy-helm">
        <path d="M35 60 C24 57 16 46 18 33 C27 38 33 48 36 56 Z" fill={`url(#${id('horn')})`} stroke="#8d7f5c" strokeWidth="1.4" />
        <path d="M85 60 C96 57 104 46 102 33 C93 38 87 48 84 56 Z" fill={`url(#${id('horn')})`} stroke="#8d7f5c" strokeWidth="1.4" />
        {!mini && <><circle cx="19" cy="35" r="2.4" fill="#e6c268" /><circle cx="101" cy="35" r="2.4" fill="#e6c268" /></>}
        <path d="M34 71 C34 53 45 43 60 43 C75 43 86 53 86 71 Z" fill={`url(#${id('helm')})`} />
        {!mini && <path d="M41 55 C47 47 53 44 60 44" stroke="rgba(255,255,255,.4)" strokeWidth="2" strokeLinecap="round" fill="none" />}
        {!mini && <path d="M60 49 V62 M60 49 L54.5 55.5 M60 49 L65.5 55.5" stroke="#e6c268" strokeWidth="2" strokeLinecap="round" fill="none" />}
        <rect x="33" y="67" width="54" height="7" rx="3.5" fill="#3c4a56" />
        {!mini && <><circle cx="42" cy="70.5" r="1.4" fill="#9fb0bf" /><circle cx="60" cy="70.5" r="1.4" fill="#9fb0bf" /><circle cx="78" cy="70.5" r="1.4" fill="#9fb0bf" /></>}
        <rect x="57.5" y="69" width="5" height="12" rx="2.5" fill="#465563" />
      </g>

      {/* щёчки */}
      {(mood === 'happy' || mood === 'party') && (
        <>
          <circle cx="42" cy="100" r="5" fill="#ff8a5c" opacity=".45" />
          <circle cx="78" cy="100" r="5" fill="#ff8a5c" opacity=".45" />
        </>
      )}

      {/* брови для sad/think */}
      {mood === 'sad' && <path d="M44 78 L55 81 M76 78 L65 81" stroke="#4a2400" strokeWidth="3" strokeLinecap="round" fill="none" />}
      {mood === 'think' && !mini && <path d="M63 73 Q70 70 77 73" stroke="#4a2400" strokeWidth="3" strokeLinecap="round" fill="none" />}

      {/* глаза */}
      <g className="buddy-eyes">
        <rect x={42 + eyeDx} y={eyeY} width="8" height={eyeH} rx="4" fill="#4a2400" />
        <rect x={70 + eyeDx} y={eyeY} width="8" height={eyeH} rx="4" fill="#4a2400" />
        {mood !== 'sad' && (
          <>
            <circle cx={48.2 + eyeDx} cy={eyeY + 4} r="2" fill="#fff1d6" />
            <circle cx={76.2 + eyeDx} cy={eyeY + 4} r="2" fill="#fff1d6" />
            {!mini && <><circle cx={45.5 + eyeDx} cy={eyeY + 9} r="1" fill="#ffe0a8" opacity=".8" /><circle cx={73.5 + eyeDx} cy={eyeY + 9} r="1" fill="#ffe0a8" opacity=".8" /></>}
          </>
        )}
      </g>

      {mouth(mood)}

      {/* золотые искры вокруг на party */}
      {mood === 'party' && (
        <g fill="#e6c268">
          <rect x="14" y="40" width="6" height="6" transform="rotate(45 17 43)" opacity=".9" />
          <rect x="98" y="52" width="5" height="5" transform="rotate(45 100 54)" opacity=".7" />
          <rect x="24" y="96" width="5" height="5" transform="rotate(45 26 98)" opacity=".8" />
          <rect x="94" y="100" width="6" height="6" transform="rotate(45 97 103)" opacity=".6" />
        </g>
      )}
    </svg>
  )
}
