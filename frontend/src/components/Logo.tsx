export default function Logo({ suffix, className = '' }: { suffix: string; className?: string }) {
  return (
    <div className={`font-bold tracking-[-0.5px] ${className}`}>
      Le<span className="text-brand">Mans</span> {suffix}
    </div>
  );
}
