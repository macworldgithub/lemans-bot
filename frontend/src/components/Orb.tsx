export type OrbState = 'idle' | 'listening' | 'speaking';

const STYLES: Record<OrbState, { orb: string; ring: string }> = {
  idle: { orb: 'bg-brand shadow-[0_0_24px_rgba(225,29,72,0.35)]', ring: 'border-brand animate-ring' },
  listening: { orb: 'bg-ok shadow-[0_0_28px_rgba(34,197,94,0.45)]', ring: 'border-ok animate-ring' },
  speaking: { orb: 'bg-warn shadow-[0_0_28px_rgba(234,179,8,0.45)]', ring: 'border-warn animate-ring-fast' },
};

export default function Orb({ state }: { state: OrbState }) {
  const s = STYLES[state];
  return (
    <div className={`relative flex size-[110px] items-center justify-center rounded-full transition-all duration-400 ${s.orb}`}>
      <span className={`absolute inset-0 rounded-full border-2 ${s.ring}`} />
      <svg viewBox="0 0 24 24" className="size-[38px] fill-white" aria-hidden="true">
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
      </svg>
    </div>
  );
}
