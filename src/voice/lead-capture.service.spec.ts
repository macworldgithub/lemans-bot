import { ConfigService } from '@nestjs/config';
import { Model, Mongoose } from 'mongoose';
import OpenAI from 'openai';
import { ActiveCampaignService } from '../integrations/active-campaign.service';
import { LeadSchema as TradieLeadSchema } from '../lead/schemas/lead.schema';
import { LeadCaptureService, LeadFields } from './lead-capture.service';
import {
  LeadDocument,
  LeadSchema,
  VOICE_LEAD_MODEL,
} from './schemas/lead.schema';
import { SAVE_LEAD_TOOL } from './lemans-knowledge';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));

const fields: LeadFields = {
  caller_name: 'Sarah',
  caller_number: '0412 345 678',
  caller_email: null,
  event_type: 'karts',
  event_date: 'next Saturday',
  group_size: 12,
  enquiry_details: 'New kart booking for 12 people.',
  preferred_language: null,
};

describe('LeadCaptureService', () => {
  let service: LeadCaptureService;
  let backend: jest.Mock;
  let records: Map<string, Record<string, unknown>>;
  let leads: { findOneAndUpdate: jest.Mock; updateOne: jest.Mock };
  let crm: { createContact: jest.Mock };
  let saved: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    backend = jest
      .fn()
      .mockResolvedValue({
        output: [
          {
            type: 'function_call',
            name: 'save_lead',
            arguments: JSON.stringify(fields),
          },
        ],
      });
    jest
      .mocked(OpenAI)
      .mockImplementation(
        () => ({ responses: { create: backend } }) as unknown as OpenAI,
      );
    records = new Map();
    leads = {
      findOneAndUpdate: jest.fn((filter, update) => ({
        exec: async () => {
          const record = JSON.parse(JSON.stringify(update.$set));
          records.set(String(filter._id), record);
          return { ...record, _id: filter._id };
        },
      })),
      updateOne: jest.fn(() => ({ exec: async () => ({}) })),
    };
    crm = { createContact: jest.fn().mockResolvedValue(null) };
    saved = jest.fn();
    service = new LeadCaptureService(
      {
        get: (key: string) =>
          key === 'OPENAI_API_KEY' ? 'test-key' : undefined,
      } as unknown as ConfigService,
      leads as unknown as Model<LeadDocument>,
      crm as unknown as ActiveCampaignService,
    );
  });

  afterEach(() => jest.useRealTimers());

  function start(key = 'browser') {
    service.startSession(key, 'unknown', { onSaved: saved });
  }

  function transcript(key = 'browser') {
    service.appendTranscript(key, 'assistant', 'What is your name?', 0, 500);
    service.appendTranscript(key, 'user', 'Sarah.', 600, 900);
    service.appendTranscript(
      key,
      'assistant',
      'What is your callback number?',
      1000,
      1500,
    );
    service.appendTranscript(
      key,
      'user',
      'Zero four one two three four five six seven eight. Karting for twelve people next Saturday.',
      1600,
      3000,
    );
  }

  it('registers the strict named tool and supplies both speakers for short and spoken replies', async () => {
    start();
    transcript();
    await service.captureLead('browser');
    expect(backend).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [SAVE_LEAD_TOOL],
        tool_choice: { type: 'function', name: 'save_lead' },
        parallel_tool_calls: false,
        store: false,
      }),
    );
    const context = JSON.parse(backend.mock.calls[0][0].input);
    expect(
      context.conversation.map((turn: { role: string }) => turn.role),
    ).toEqual(['assistant', 'user', 'assistant', 'user']);
    expect(context.conversation[1].text).toBe('Sarah.');
    expect([...records.values()][0]).toMatchObject({
      callerName: 'Sarah',
      callerNumber: '0412345678',
      eventType: 'karts',
      captureStatus: 'complete',
    });
    await service.finalizeSession('browser');
  });

  it('updates one lead with corrections without creating a CRM contact for each delegation', async () => {
    start();
    transcript();
    const first = await service.captureLead('browser');
    service.appendTranscript(
      'browser',
      'user',
      'Actually, twenty people on Sunday.',
      5000,
      6000,
    );
    backend.mockResolvedValueOnce({
      output: [
        {
          type: 'function_call',
          name: 'save_lead',
          arguments: JSON.stringify({
            ...fields,
            group_size: 20,
            event_date: 'Sunday',
          }),
        },
      ],
    });
    const second = await service.captureLead('browser');
    expect(second.lead_id).toBe(first.lead_id);
    expect(records.size).toBe(1);
    expect([...records.values()][0]).toMatchObject({
      groupSize: 20,
      eventDate: 'Sunday',
    });
    expect(crm.createContact).not.toHaveBeenCalled();
    await service.finalizeSession('browser');
    expect(crm.createContact).toHaveBeenCalledTimes(1);
  });

  it('creates different records for repeated calls on the same connection, including silent calls', async () => {
    start();
    await service.finalizeSession('browser');
    start();
    await service.finalizeSession('browser');
    expect(records.size).toBe(2);
    const rows = [...records.values()];
    expect(rows[0].callId).not.toBe(rows[1].callId);
    expect(
      rows.every(
        (row) =>
          row.captureStatus === 'partial' &&
          row.endedAt &&
          row.callerName === null,
      ),
    ).toBe(true);
    expect(backend).not.toHaveBeenCalled();
  });

  it('extracts at call end when the voice model never delegated and shares duplicate end requests', async () => {
    start();
    transcript();
    const first = service.finalizeSession('browser');
    expect(service.finalizeSession('browser')).toBe(first);
    await first;
    expect(backend).toHaveBeenCalledTimes(1);
    expect(records.size).toBe(1);
    expect([...records.values()][0]).toMatchObject({
      callerName: 'Sarah',
      captureStatus: 'complete',
      endedAt: expect.any(String),
    });
  });

  it.each(['invalid arguments', 'API unavailable'])(
    'retains raw data as a partial record when extraction fails: %s',
    async (failure) => {
      start();
      transcript();
      if (failure === 'API unavailable')
        backend.mockRejectedValueOnce(new Error('API unavailable'));
      else
        backend.mockResolvedValueOnce({
          output: [
            {
              type: 'function_call',
              name: 'save_lead',
              arguments: '{"caller_name":"Invented"}',
            },
          ],
        });
      await service.finalizeSession('browser');
      const row = [...records.values()][0];
      expect(row).toMatchObject({
        callerName: null,
        captureStatus: 'partial',
        extractionStatus: 'failed',
      });
      expect(String(row.callerTranscript)).toContain('Zero four one two');
      expect(crm.createContact).not.toHaveBeenCalled();
    },
  );

  it('saves partial calls without contact details', async () => {
    start();
    service.appendTranscript(
      'browser',
      'user',
      'What karting activities do you have?',
    );
    backend.mockResolvedValueOnce({
      output: [
        {
          type: 'function_call',
          name: 'save_lead',
          arguments: JSON.stringify({
            ...fields,
            caller_name: null,
            caller_number: null,
          }),
        },
      ],
    });
    await service.finalizeSession('browser');
    expect([...records.values()][0]).toMatchObject({
      callerName: null,
      callerNumber: null,
      captureStatus: 'partial',
    });
  });

  it('retries a failed end save with the same record ID', async () => {
    start();
    transcript();
    await service.captureLead('browser');
    leads.findOneAndUpdate.mockImplementationOnce(() => ({
      exec: async () => {
        throw new Error('DB offline');
      },
    }));
    await expect(service.finalizeSession('browser')).rejects.toThrow(
      'DB offline',
    );
    await service.finalizeSession('browser');
    expect(records.size).toBe(1);
  });

  it('persists raw context during a call before delegation or hangup', async () => {
    start();
    transcript();
    await jest.advanceTimersByTimeAsync(1000);
    expect([...records.values()][0].callerTranscript).toContain('Sarah.');
    expect(backend).not.toHaveBeenCalled();
    await service.finalizeSession('browser');
  });

  it('automatically retries a failed final database write without creating a duplicate', async () => {
    start();
    await jest.advanceTimersByTimeAsync(0);
    leads.findOneAndUpdate.mockImplementationOnce(() => ({
      exec: async () => {
        throw new Error('DB offline');
      },
    }));
    await expect(service.finalizeSession('browser')).rejects.toThrow(
      'DB offline',
    );
    await jest.advanceTimersByTimeAsync(5000);
    expect(records.size).toBe(1);
    expect([...records.values()][0].endedAt).toBeTruthy();
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('saves active calls during graceful shutdown', async () => {
    start('first');
    start('second');
    await service.beforeApplicationShutdown();
    expect(records.size).toBe(2);
    expect([...records.values()].every((row) => row.endedAt)).toBe(true);
  });

  it('accepts partial voice leads independently of the tradie schema', async () => {
    jest.useRealTimers();
    const connection = new Mongoose().createConnection();
    const tradieModel = connection.model('Lead', TradieLeadSchema);
    const voiceModel = connection.model(VOICE_LEAD_MODEL, LeadSchema);
    expect(voiceModel).not.toBe(tradieModel);
    await expect(
      new voiceModel({
        callerName: null,
        eventType: 'unknown',
        enquiryDetails: 'Incomplete call',
        callId: 'test',
      }).validate(),
    ).resolves.toBeUndefined();
    await connection.close();
  });
});
