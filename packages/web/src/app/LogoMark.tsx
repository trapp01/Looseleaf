/** The Looseleaf mark: a loose sheet of ruled paper with a margin line and punched holes. */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo-mark">
      <g transform="rotate(-6 32 32)">
        <rect x="12" y="6" width="42" height="52" rx="4" fill="#fff" stroke="var(--accent, #7b3fb5)" strokeWidth="3" />
        <path d="M22 18h26M22 27h26M22 36h26M22 45h18" stroke="var(--accent, #7b3fb5)" strokeWidth="2.5" strokeLinecap="round" opacity=".55" />
        <path d="M19 9v46" stroke="#e07a9a" strokeWidth="2" />
        <circle cx="15.5" cy="18" r="2" fill="var(--accent, #7b3fb5)" />
        <circle cx="15.5" cy="32" r="2" fill="var(--accent, #7b3fb5)" />
        <circle cx="15.5" cy="46" r="2" fill="var(--accent, #7b3fb5)" />
      </g>
    </svg>
  );
}
