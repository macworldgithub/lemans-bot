export interface SmsSendRequest {
  to: string; // +614...
  body: string;
  operationId: string;
}

export interface SmsSendResult {
  status: 'accepted' | 'failed' | 'simulated';
  providerMessageId?: string;
  error?: string;
}

export interface SmsProvider {
  readonly name: string;
  send(req: SmsSendRequest): Promise<SmsSendResult>;
}

export class FakeSmsProvider implements SmsProvider {
  readonly name = 'fake';
  readonly sent: SmsSendRequest[] = [];
  nextStatus: 'accepted' | 'failed' = 'accepted';

  async send(req: SmsSendRequest): Promise<SmsSendResult> {
    this.sent.push(req);
    if (this.nextStatus === 'failed') {
      return { status: 'failed', error: 'Simulated provider failure' };
    }
    return {
      status: 'accepted',
      providerMessageId: `fake-msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    };
  }
}
