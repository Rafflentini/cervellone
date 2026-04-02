export default function CervelloneLogo({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Alone esterno futuristico */}
      <circle cx="60" cy="56" r="46" fill="none" stroke="url(#auraglow)" strokeWidth="0.5" opacity="0.3" />

      {/* Cervello — forma anatomica più definita */}
      <g filter="url(#brainGlow)">
        {/* Emisfero sinistro */}
        <path d="M58 20c-6 0-12 2-17 6-5 4-9 10-10 17-2 7-1 13 1 19 1 4 3 7 4 10 2 5 2 9 0 13-1 3-1 6 1 8 2 3 5 4 9 4h12"
          fill="url(#brainLeft)" />
        {/* Emisfero destro */}
        <path d="M62 20c6 0 12 2 17 6 5 4 9 10 10 17 2 7 1 13-1 19-1 4-3 7-4 10-2 5-2 9 0 13 1 3 1 6-1 8-2 3-5 4-9 4H62"
          fill="url(#brainRight)" />

        {/* Solchi principali — definiti e profondi */}
        {/* Fessura interemisferica centrale */}
        <path d="M60 22v75" stroke="#1e3a5f" strokeWidth="1.8" opacity="0.6" />

        {/* Solchi emisfero sinistro */}
        <path d="M56 28c-10 2-18 8-22 16" stroke="#1e3a5f" strokeWidth="1.2" opacity="0.45" fill="none" strokeLinecap="round" />
        <path d="M54 40c-8 1-16 5-21 12" stroke="#1e3a5f" strokeWidth="1.1" opacity="0.4" fill="none" strokeLinecap="round" />
        <path d="M52 54c-7 2-13 6-17 12" stroke="#1e3a5f" strokeWidth="1.1" opacity="0.4" fill="none" strokeLinecap="round" />
        <path d="M50 66c-5 3-9 7-11 12" stroke="#1e3a5f" strokeWidth="1" opacity="0.35" fill="none" strokeLinecap="round" />
        {/* Solco laterale sinistro */}
        <path d="M34 36c4 8 2 18-1 26" stroke="#1e3a5f" strokeWidth="1" opacity="0.35" fill="none" strokeLinecap="round" />

        {/* Solchi emisfero destro */}
        <path d="M64 28c10 2 18 8 22 16" stroke="#1e3a5f" strokeWidth="1.2" opacity="0.45" fill="none" strokeLinecap="round" />
        <path d="M66 40c8 1 16 5 21 12" stroke="#1e3a5f" strokeWidth="1.1" opacity="0.4" fill="none" strokeLinecap="round" />
        <path d="M68 54c7 2 13 6 17 12" stroke="#1e3a5f" strokeWidth="1.1" opacity="0.4" fill="none" strokeLinecap="round" />
        <path d="M70 66c5 3 9 7 11 12" stroke="#1e3a5f" strokeWidth="1" opacity="0.35" fill="none" strokeLinecap="round" />
        {/* Solco laterale destro */}
        <path d="M86 36c-4 8-2 18 1 26" stroke="#1e3a5f" strokeWidth="1" opacity="0.35" fill="none" strokeLinecap="round" />
      </g>

      {/* === SINAPSI BLU — rete neurale luminosa === */}
      <g opacity="0.9">
        {/* Nodi sinaptici — punti luminosi */}
        <circle cx="42" cy="32" r="2" fill="#60a5fa" filter="url(#synGlow)" />
        <circle cx="36" cy="48" r="1.8" fill="#38bdf8" filter="url(#synGlow)" />
        <circle cx="44" cy="58" r="2" fill="#60a5fa" filter="url(#synGlow)" />
        <circle cx="38" cy="72" r="1.5" fill="#38bdf8" filter="url(#synGlow)" />
        <circle cx="50" cy="42" r="1.5" fill="#818cf8" filter="url(#synGlow)" />
        <circle cx="48" cy="80" r="1.8" fill="#60a5fa" filter="url(#synGlow)" />

        <circle cx="78" cy="32" r="2" fill="#60a5fa" filter="url(#synGlow)" />
        <circle cx="84" cy="48" r="1.8" fill="#38bdf8" filter="url(#synGlow)" />
        <circle cx="76" cy="58" r="2" fill="#60a5fa" filter="url(#synGlow)" />
        <circle cx="82" cy="72" r="1.5" fill="#38bdf8" filter="url(#synGlow)" />
        <circle cx="70" cy="42" r="1.5" fill="#818cf8" filter="url(#synGlow)" />
        <circle cx="72" cy="80" r="1.8" fill="#60a5fa" filter="url(#synGlow)" />

        {/* Nodi centrali */}
        <circle cx="60" cy="36" r="2.2" fill="#a78bfa" filter="url(#synGlow)" />
        <circle cx="60" cy="54" r="2" fill="#818cf8" filter="url(#synGlow)" />
        <circle cx="60" cy="72" r="2.2" fill="#a78bfa" filter="url(#synGlow)" />
        <circle cx="60" cy="88" r="1.8" fill="#818cf8" filter="url(#synGlow)" />

        {/* Connessioni sinaptiche — linee luminose blu */}
        {/* Emisfero sinistro */}
        <line x1="42" y1="32" x2="50" y2="42" stroke="#60a5fa" strokeWidth="0.8" opacity="0.7" />
        <line x1="50" y1="42" x2="36" y2="48" stroke="#38bdf8" strokeWidth="0.7" opacity="0.6" />
        <line x1="36" y1="48" x2="44" y2="58" stroke="#60a5fa" strokeWidth="0.8" opacity="0.65" />
        <line x1="44" y1="58" x2="38" y2="72" stroke="#38bdf8" strokeWidth="0.7" opacity="0.6" />
        <line x1="38" y1="72" x2="48" y2="80" stroke="#60a5fa" strokeWidth="0.8" opacity="0.65" />
        <line x1="42" y1="32" x2="36" y2="48" stroke="#818cf8" strokeWidth="0.6" opacity="0.4" />
        <line x1="44" y1="58" x2="48" y2="80" stroke="#818cf8" strokeWidth="0.6" opacity="0.4" />

        {/* Emisfero destro */}
        <line x1="78" y1="32" x2="70" y2="42" stroke="#60a5fa" strokeWidth="0.8" opacity="0.7" />
        <line x1="70" y1="42" x2="84" y2="48" stroke="#38bdf8" strokeWidth="0.7" opacity="0.6" />
        <line x1="84" y1="48" x2="76" y2="58" stroke="#60a5fa" strokeWidth="0.8" opacity="0.65" />
        <line x1="76" y1="58" x2="82" y2="72" stroke="#38bdf8" strokeWidth="0.7" opacity="0.6" />
        <line x1="82" y1="72" x2="72" y2="80" stroke="#60a5fa" strokeWidth="0.8" opacity="0.65" />
        <line x1="78" y1="32" x2="84" y2="48" stroke="#818cf8" strokeWidth="0.6" opacity="0.4" />
        <line x1="76" y1="58" x2="72" y2="80" stroke="#818cf8" strokeWidth="0.6" opacity="0.4" />

        {/* Connessioni cross-emisferiche (tra i due emisferi) */}
        <line x1="42" y1="32" x2="60" y2="36" stroke="#a78bfa" strokeWidth="0.7" opacity="0.5" />
        <line x1="78" y1="32" x2="60" y2="36" stroke="#a78bfa" strokeWidth="0.7" opacity="0.5" />
        <line x1="50" y1="42" x2="60" y2="54" stroke="#a78bfa" strokeWidth="0.6" opacity="0.45" />
        <line x1="70" y1="42" x2="60" y2="54" stroke="#a78bfa" strokeWidth="0.6" opacity="0.45" />
        <line x1="44" y1="58" x2="60" y2="54" stroke="#818cf8" strokeWidth="0.6" opacity="0.4" />
        <line x1="76" y1="58" x2="60" y2="54" stroke="#818cf8" strokeWidth="0.6" opacity="0.4" />
        <line x1="38" y1="72" x2="60" y2="72" stroke="#a78bfa" strokeWidth="0.7" opacity="0.5" />
        <line x1="82" y1="72" x2="60" y2="72" stroke="#a78bfa" strokeWidth="0.7" opacity="0.5" />
        <line x1="48" y1="80" x2="60" y2="88" stroke="#818cf8" strokeWidth="0.6" opacity="0.45" />
        <line x1="72" y1="80" x2="60" y2="88" stroke="#818cf8" strokeWidth="0.6" opacity="0.45" />

        {/* Connessioni verticali centrali (spina dorsale della rete) */}
        <line x1="60" y1="36" x2="60" y2="54" stroke="#c4b5fd" strokeWidth="0.9" opacity="0.55" />
        <line x1="60" y1="54" x2="60" y2="72" stroke="#c4b5fd" strokeWidth="0.9" opacity="0.55" />
        <line x1="60" y1="72" x2="60" y2="88" stroke="#c4b5fd" strokeWidth="0.8" opacity="0.45" />
      </g>

      {/* Tronco encefalico stilizzato */}
      <path d="M54 93c2 6 3 12 6 16 3-4 4-10 6-16" fill="url(#brainLeft)" opacity="0.7" />

      {/* Bordo cervello — contorno netto */}
      <path d="M58 20c-6 0-12 2-17 6-5 4-9 10-10 17-2 7-1 13 1 19 1 4 3 7 4 10 2 5 2 9 0 13-1 3-1 6 1 8 2 3 5 4 9 4h12"
        fill="none" stroke="#3b82f6" strokeWidth="1" opacity="0.4" />
      <path d="M62 20c6 0 12 2 17 6 5 4 9 10 10 17 2 7 1 13-1 19-1 4-3 7-4 10-2 5-2 9 0 13 1 3 1 6-1 8-2 3-5 4-9 4H62"
        fill="none" stroke="#3b82f6" strokeWidth="1" opacity="0.4" />

      {/* Defs */}
      <defs>
        {/* Gradiente emisfero sinistro — toni scuri con riflesso blu */}
        <linearGradient id="brainLeft" x1="28" y1="20" x2="60" y2="97" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#c4b5fd" />
          <stop offset="35%" stopColor="#a78bfa" />
          <stop offset="70%" stopColor="#7c3aed" />
          <stop offset="100%" stopColor="#5b21b6" />
        </linearGradient>
        {/* Gradiente emisfero destro — speculare */}
        <linearGradient id="brainRight" x1="92" y1="20" x2="60" y2="97" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#bfdbfe" />
          <stop offset="35%" stopColor="#93c5fd" />
          <stop offset="70%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#1d4ed8" />
        </linearGradient>
        {/* Alone esterno */}
        <radialGradient id="auraglow" cx="60" cy="56" r="46" gradientUnits="userSpaceOnUse">
          <stop offset="70%" stopColor="#3b82f6" stopOpacity="0" />
          <stop offset="100%" stopColor="#60a5fa" stopOpacity="0.3" />
        </radialGradient>
        {/* Glow cervello */}
        <filter id="brainGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
        {/* Glow sinapsi */}
        <filter id="synGlow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="2.5" result="glow" />
          <feMerge>
            <feMergeNode in="glow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
    </svg>
  )
}
