import type { ReactNode } from 'react';

const VARIANTS = {
  lead: 'bg-ok/8 border-ok/25 text-ok',
  transfer: 'bg-warn/8 border-warn/25 text-warn',
};

export default function Notice({ variant, children }: { variant: keyof typeof VARIANTS; children: ReactNode }) {
  return <div className={`mt-4 rounded-[10px] border px-4 py-3.5 text-sm leading-normal ${VARIANTS[variant]}`}>{children}</div>;
}
