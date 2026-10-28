import { useLayoutEffect, useRef } from 'react';

import { DEFAULT_NAMES, formatStamp, type SpeakerNames, type TranscriptLine } from '../lib/transcript';

interface TranscriptLogProps {
  lines: TranscriptLine[];
  startedAt: number | null;
  names?: SpeakerNames;
  emptyText: string;
  className?: string;
}

const STICK_THRESHOLD_PX = 60;

export default function TranscriptLog({
  lines,
  startedAt,
  names = DEFAULT_NAMES,
  emptyText,
  className = '',
}: TranscriptLogProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Follow new text only while the reader is already at the bottom.
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  const start = startedAt ?? lines[0]?.ts ?? null;

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className={`flex flex-col gap-2.5 overflow-y-auto rounded-xl border border-line bg-white/[0.03] p-3.5 ${className}`}
    >
      {lines.length === 0 ? (
        <div className="m-auto text-sm text-muted">{emptyText}</div>
      ) : (
        lines.map((line) => (
          <Message key={`${line.role}:${line.id}`} line={line} name={names[line.role]} stamp={formatStamp(line.ts, start)} />
        ))
      )}
    </div>
  );
}

function Message({ line, name, stamp }: { line: TranscriptLine; name: string; stamp: string }) {
  const isBot = line.role === 'bot';
  const hasText = line.text.trim().length > 0;
  const body = hasText ? line.text : line.final ? '(no speech recognised)' : isBot ? '…' : 'listening…';

  const bubble = isBot
    ? 'self-start rounded-bl-[4px] border-brand/30 bg-brand/12'
    : 'self-end rounded-br-[4px] border-indigo-400/30 bg-indigo-400/14';

  return (
    <div
      className={[
        'max-w-[86%] rounded-xl border px-3 py-2 text-[0.9rem] leading-normal break-words whitespace-pre-wrap text-fg',
        bubble,
        line.interrupted ? 'opacity-75' : '',
      ].join(' ')}
    >
      <div className="mb-0.5 flex items-baseline gap-2 text-[0.66rem] tracking-[0.8px] whitespace-normal text-zinc-400 uppercase">
        <span className={`font-semibold ${isBot ? 'text-rose-400' : 'text-indigo-300'}`}>{name}</span>
        <span>{stamp}</span>
        {line.interrupted && <span className="text-warn">interrupted</span>}
      </div>
      <div
        className={[
          !hasText ? 'text-muted italic' : '',
          !line.final ? "after:ml-0.5 after:animate-blink after:text-zinc-400 after:content-['▍']" : '',
        ].join(' ')}
      >
        {body}
      </div>
    </div>
  );
}
