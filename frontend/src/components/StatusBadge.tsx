export type BadgeTone = 'default' | 'connected' | 'speaking';

const TONES: Record<BadgeTone, string> = {
  default: 'bg-brand/15 text-rose-400 border-brand/25',
  connected: 'bg-ok/12 text-ok border-ok/25',
  speaking: 'bg-warn/12 text-warn border-warn/25',
};

export default function StatusBadge({ text, tone = 'default' }: { text: string; tone?: BadgeTone }) {
  return (
    <div className={`rounded-full border px-3.5 py-1 text-xs font-semibold tracking-[0.3px] transition-all duration-300 ${TONES[tone]}`}>
      {text}
    </div>
  );
}
