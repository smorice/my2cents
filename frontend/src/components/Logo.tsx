/** Mark: a dotted past trajectory turning into a solid projected one — looking back to read forward. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" className="fill-ink" />
      <path d="M5.5 22.5 C8.5 22.5 9.8 20.6 11.2 18.4" fill="none" className="stroke-bg" strokeOpacity=".55" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="0.1 3.6" />
      <path d="M11.2 18.4 C13 15.5 14 12.5 16.6 12.5 C19.6 12.5 20.4 17.5 26 9.5" fill="none" className="stroke-accent" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="26" cy="9.5" r="2.5" className="fill-bg" />
      <circle cx="26" cy="9.5" r="1.3" className="fill-accent" />
    </svg>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 select-none">
      <LogoMark />
      {!compact && (
        <span className="text-[17px] tracking-tight leading-none">
          <span className="font-light text-ink2">My</span>
          <span className="mx-[1px] font-semibold text-accent">2</span>
          <span className="font-semibold text-ink">cents</span>
        </span>
      )}
    </span>
  );
}
