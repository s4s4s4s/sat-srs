/**
 * Пейзаж фьорда — «среда» для Home и Summary (только тёмная тема).
 * Небо + северное сияние (дрейф) + два слоя гор + вода с золотым бликом +
 * драккар со щитами + костёр с эмберами. Движение живёт ТОЛЬКО здесь и на Summary.
 */
export default function FjordScene({ tall = false }: { tall?: boolean }) {
  return (
    <div className={`fjord${tall ? ' fjord-tall' : ''}`} aria-hidden>
      <div className="aurora" />
      <svg className="fjord-svg" viewBox="0 0 375 340" preserveAspectRatio="xMidYMin slice">
        <defs>
          <linearGradient id="fj-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0c1f2e" />
            <stop offset="1" stopColor="#16384c" />
          </linearGradient>
          <radialGradient id="fj-fire" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#ffb84d" stopOpacity="0.7" />
            <stop offset="0.45" stopColor="#f2801c" stopOpacity="0.35" />
            <stop offset="1" stopColor="#f2801c" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="375" height="340" fill="url(#fj-sky)" />
        {/* звёзды */}
        <g fill="#dfeaf2">
          <circle cx="48" cy="42" r="1" opacity=".5" />
          <circle cx="120" cy="30" r="1.3" opacity=".7" />
          <circle cx="210" cy="52" r="1" opacity=".45" />
          <circle cx="300" cy="34" r="1.2" opacity=".6" />
          <circle cx="338" cy="70" r="1" opacity=".4" />
          <circle cx="76" cy="88" r="1" opacity=".35" />
        </g>
        {/* дальние горы */}
        <path d="M0 200 L60 150 L120 190 L180 140 L250 195 L310 150 L375 190 L375 240 L0 240 Z" fill="#13303f" />
        {/* ближние горы */}
        <path d="M0 235 L70 185 L150 232 L230 178 L300 228 L375 195 L375 260 L0 260 Z" fill="#0d2130" />
        {/* вода */}
        <rect x="0" y="256" width="375" height="84" fill="#0a1a26" />
        {/* золотой блик по воде */}
        <rect x="0" y="266" width="375" height="2" fill="#e6c268" opacity=".22" />
        <rect x="150" y="272" width="75" height="1.5" fill="#e6c268" opacity=".3" />
        {/* драккар: корпус, мачта, парус, вёсла, ряд щитов */}
        <g transform="translate(232 246)">
          <path d="M-58 24 Q-64 8 -50 6 L48 6 Q62 8 56 24 Q0 34 -58 24 Z" fill="#071019" />
          <path d="M-50 6 Q-56 -6 -46 -10 L-40 6 Z" fill="#071019" />
          <path d="M48 6 Q56 -4 46 -9 L40 6 Z" fill="#071019" />
          <rect x="-2" y="-30" width="3" height="36" fill="#0c1c28" />
          <path d="M2 -28 L26 -12 L2 -6 Z" fill="#132c3c" opacity=".85" />
          {/* щиты */}
          <g>
            <circle cx="-42" cy="12" r="5.5" fill="#1a3140" stroke="#e6c268" strokeWidth="1" strokeOpacity=".5" />
            <circle cx="-28" cy="13" r="5.5" fill="#20303a" stroke="#9fb0bf" strokeWidth="1" strokeOpacity=".4" />
            <circle cx="-14" cy="14" r="5.5" fill="#1a3140" stroke="#e6c268" strokeWidth="1" strokeOpacity=".5" />
            <circle cx="0" cy="14" r="5.5" fill="#20303a" stroke="#9fb0bf" strokeWidth="1" strokeOpacity=".4" />
            <circle cx="14" cy="14" r="5.5" fill="#1a3140" stroke="#e6c268" strokeWidth="1" strokeOpacity=".5" />
            <circle cx="28" cy="13" r="5.5" fill="#20303a" stroke="#9fb0bf" strokeWidth="1" strokeOpacity=".4" />
            <circle cx="42" cy="12" r="5.5" fill="#1a3140" stroke="#e6c268" strokeWidth="1" strokeOpacity=".5" />
          </g>
        </g>
        {/* костёр на берегу */}
        <ellipse className="fj-fireglow" cx="70" cy="250" rx="46" ry="40" fill="url(#fj-fire)" />
        <g transform="translate(70 250)">
          <path d="M-9 8 L9 8 L6 12 L-6 12 Z" fill="#3a2a1a" />
          <path d="M0 -14 C-5 -6 -7 0 -4 6 C-2 2 0 0 0 -2 C0 0 2 2 4 6 C7 0 5 -6 0 -14 Z" fill="#ffb03a" />
          <path d="M0 -6 C-2 -2 -3 2 -1 6 C0 4 0 2 0 1 C0 2 1 4 2 6 C3 2 2 -2 0 -6 Z" fill="#ffe08a" />
        </g>
      </svg>
      <i className="ember e1" />
      <i className="ember e2" />
      <i className="ember e3" />
    </div>
  )
}
