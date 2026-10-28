import { useEffect, useRef, useState } from 'react';

import Logo from '../components/Logo';
import TranscriptLog from '../components/TranscriptLog';
import { useMonitorFeed, type MonitoredCall } from '../hooks/useMonitorFeed';
import { downloadText, fileStamp, finalizeAll, toPlainText, DEFAULT_NAMES } from '../lib/transcript';

const EMPTY_CALLS = 'No calls yet. Start a web demo or ring the phone line.';

/** Live view of every call (web demo and phone) streamed from the API. */
export default function MonitorPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(follow);
  followRef.current = follow;

  const { calls: sorted, connected } = useMonitorFeed((callId) => {
    if (followRef.current) setSelectedId(callId);
  });

  // Nothing selected yet: show the newest call.
  useEffect(() => {
    if (!selectedId && sorted[0]) setSelectedId(sorted[0].callId);
  }, [selectedId, sorted]);

  const selected = sorted.find((c) => c.callId === selectedId) ?? null;
  const lines = selected ? (selected.endedAt ? finalizeAll(selected.lines) : selected.lines) : [];

  const download = () => {
    if (!selected) return;
    const stamp = fileStamp(new Date(selected.startedAt));
    downloadText(`lemans-${selected.source}-${stamp}.txt`, toPlainText(lines, selected.startedAt, DEFAULT_NAMES));
  };

  return (
    <div className="flex h-screen flex-col gap-3.5 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Logo suffix="Call Monitor" className="text-xl" />
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <span className={`size-2 rounded-full ${connected ? 'bg-ok' : 'bg-muted'}`} />
          <span>{connected ? 'Live' : 'Disconnected — reconnecting…'}</span>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[260px_1fr] gap-3.5 max-[720px]:grid-cols-1 max-[720px]:grid-rows-[auto_1fr]">
        <aside className="flex min-h-0 flex-col gap-1 overflow-y-auto rounded-[14px] border border-line bg-card p-2 max-[720px]:max-h-[180px]">
          {sorted.length === 0 ? (
            <div className="p-3 text-sm text-muted">{EMPTY_CALLS}</div>
          ) : (
            sorted.map((c) => <CallItem key={c.callId} call={c} selected={c.callId === selectedId} onSelect={setSelectedId} />)
          )}
        </aside>

        <section className="flex min-h-0 flex-col gap-2.5 rounded-[14px] border border-line bg-card p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2.5 text-[0.8rem] text-muted">
            <span>{selected ? callTitle(selected) : 'Select a call'}</span>
            <span className="flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-brand" />
                Follow newest call
              </label>
              <button
                type="button"
                onClick={download}
                disabled={!selected}
                className="cursor-pointer rounded-lg border border-line bg-white/7 px-3 py-1.5 text-[0.78rem] text-fg disabled:cursor-default disabled:opacity-40"
              >
                Download
              </button>
            </span>
          </div>
          <TranscriptLog
            lines={lines}
            startedAt={selected?.startedAt ?? null}
            emptyText="Transcript will stream here live"
            className="min-h-0 flex-1 max-[720px]:min-h-[360px]"
          />
        </section>
      </main>
    </div>
  );
}

/** Room names look like "web-1d7f76fb"; show the random part. */
const shortId = (callId: string) => callId.replace(/^web-/, '').slice(0, 6);

function callTitle(c: MonitoredCall): string {
  const kind = c.source === 'phone' ? 'Phone' : 'Web demo';
  const who = c.source === 'phone' ? c.callerNumber : shortId(c.callId);
  return `${kind} · ${who} · started ${new Date(c.startedAt).toLocaleTimeString()}${c.endedAt ? ' · ended' : ' · live'}`;
}

function CallItem({ call, selected, onSelect }: { call: MonitoredCall; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(call.callId)}
      className={`flex cursor-pointer flex-col gap-0.5 rounded-[10px] border px-3 py-2.5 text-left text-fg ${
        selected ? 'border-brand/30 bg-brand/10' : 'border-transparent hover:bg-white/4'
      }`}
    >
      <div className="flex justify-between gap-2 text-sm font-semibold">
        <span>{call.source === 'phone' ? `📞 ${call.callerNumber}` : `🌐 Web ${shortId(call.callId)}`}</span>
        <span className={`text-[0.68rem] tracking-[1px] uppercase ${call.endedAt ? 'text-muted' : 'text-ok'}`}>
          {call.endedAt ? 'ended' : '● live'}
        </span>
      </div>
      <div className="text-[0.72rem] text-muted">{new Date(call.startedAt).toLocaleTimeString()}</div>
    </button>
  );
}
