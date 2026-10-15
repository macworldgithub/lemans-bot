import { ConfigService } from '@nestjs/config';
import { LeadCaptureService } from './lead-capture.service';
import { SandwichService } from './sandwich.service';
import { VoiceService } from './voice.service';

describe('VoiceService Sandwich lead lifecycle', () => {
  it('prewarms without creating leads and finalizes only after final provider transcripts drain', async () => {
    let callbacks: any;
    let saved!: () => void;
    const lead = {
      hasPendingFinalization: jest.fn().mockReturnValue(false),
      startSession: jest.fn(),
      appendTranscript: jest.fn(),
      finalizeSession: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            saved = resolve;
          }),
      ),
      captureLead: jest.fn(),
    };
    const pipeline = {
      createSession: jest.fn(async (_id, options) => {
        callbacks = options;
      }),
      speak: jest.fn(),
      closeSession: jest.fn(async () =>
        callbacks.onTranscript('user', 'Final detail.'),
      ),
    };
    const service = new VoiceService(
      { get: () => undefined } as unknown as ConfigService,
      lead as unknown as LeadCaptureService,
      pipeline as unknown as SandwichService,
    );
    const events = jest.fn();
    await service.createRealtimeSession('web', events);
    expect(lead.startSession).not.toHaveBeenCalled();
    service.triggerGreeting('web');
    service.triggerGreeting('web');
    expect(lead.startSession).toHaveBeenCalledTimes(1);
    expect(pipeline.speak).toHaveBeenCalledTimes(1);
    const close = service.closeSession('web');
    expect(service.closeSession('web')).toBe(close);
    await Promise.resolve();
    await Promise.resolve();
    expect(lead.appendTranscript).toHaveBeenCalledWith(
      'web',
      'user',
      'Final detail.',
    );
    expect(events).not.toHaveBeenCalledWith({ type: 'session-closed' });
    saved();
    await close;
    expect(events).toHaveBeenCalledWith({ type: 'session-closed' });
    expect(service.hasSession('web')).toBe(false);
  });
});
