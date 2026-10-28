import Logo from '../components/Logo';
import Notice from '../components/Notice';
import Orb from '../components/Orb';
import StatusBadge from '../components/StatusBadge';
import TranscriptLog from '../components/TranscriptLog';
import { useVoiceCall } from '../hooks/useVoiceCall';
import { downloadText, fileStamp, toPlainText } from '../lib/transcript';

const NAMES = { bot: 'Chloe', user: 'You' };

const DEPARTMENT = { reservations: 'reservations', corporate: 'corporate events', duty_manager: 'duty manager' } as const;

const linkBtn =
  'cursor-pointer bg-transparent p-0 text-[0.68rem] tracking-[1px] text-muted uppercase underline hover:text-fg';

export default function DemoPage() {
  const call = useVoiceCall();
  const inCall = call.phase === 'connecting' || call.phase === 'active';

  const download = () =>
    downloadText(`lemans-transcript-${fileStamp(new Date())}.txt`, toPlainText(call.lines, call.startedAt, NAMES));

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[radial-gradient(at_20%_10%,rgba(225,29,72,0.12)_0,transparent_55%),radial-gradient(at_80%_90%,rgba(225,29,72,0.08)_0,transparent_55%)] p-6">
      <header className="mb-8 text-center">
        <Logo suffix="Entertainment" className="text-2xl" />
        <div className="mt-1 text-[0.85rem] text-muted">AI Receptionist — POC Demo</div>
      </header>

      <main className="w-full max-w-[640px] rounded-[20px] border border-line bg-card p-9 shadow-[0_32px_64px_-16px_rgba(0,0,0,0.6)] backdrop-blur-lg max-sm:p-6">
        <div className="mb-8 flex justify-center">
          <Orb state={call.orb} />
        </div>

        <div className="mb-7 flex justify-center">
          <StatusBadge text={call.status.text} tone={call.status.tone} />
        </div>

        <div className="flex flex-col gap-3">
          {inCall ? (
            <button
              type="button"
              onClick={call.end}
              className="cursor-pointer rounded-xl border border-line bg-white/7 p-3.5 text-[0.95rem] font-semibold tracking-[0.1px] text-fg transition-all duration-200 hover:bg-white/12"
            >
              End Call
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void call.start()}
              className="cursor-pointer rounded-xl bg-brand p-3.5 text-[0.95rem] font-semibold tracking-[0.1px] text-white transition-all duration-200 hover:-translate-y-px hover:bg-brand-dark disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Start Demo Call
            </button>
          )}
        </div>

        {call.showTranscript && (
          <section className="mt-6 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[0.68rem] tracking-[1px] text-muted uppercase">
              <span>Live transcript</span>
              <span className="flex gap-3.5">
                <button type="button" onClick={download} className={linkBtn}>
                  Download
                </button>
                <a href="/monitor" target="_blank" rel="noopener" className={linkBtn}>
                  Monitor all calls
                </a>
              </span>
            </div>
            <TranscriptLog
              lines={call.lines}
              startedAt={call.startedAt}
              names={NAMES}
              emptyText="Conversation will appear here as it happens"
              className="h-[340px]"
            />
          </section>
        )}

        {call.lead && (
          <Notice variant="lead">
            ✅ Lead saved — <strong>{call.lead.name ?? 'Unknown'}</strong> | {call.lead.eventType ?? ''} | Reservations will
            call back
          </Notice>
        )}
        {call.transfer && (
          <Notice variant="transfer">
            📞 Transfer requested → <strong>{DEPARTMENT[call.transfer.department]}</strong> (live transfer happens on phone
            calls)
          </Notice>
        )}

        {/* Agent audio elements are attached here. */}
        <div ref={call.audioRef} hidden />
      </main>
    </div>
  );
}
