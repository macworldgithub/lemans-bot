import { Model, Types } from 'mongoose';
import { LeadDocument } from '../voice/schemas/lead.schema';
import { ActiveCampaignService } from './active-campaign.service';
import { CrmDeliveryService } from './crm-delivery.service';

describe('durable CRM delivery', () => {
  let row: Record<string, any>;
  let model: { findOneAndUpdate: jest.Mock; updateOne: jest.Mock };
  let crm: { createContact: jest.Mock };
  const worker = () =>
    new CrmDeliveryService(
      model as unknown as Model<LeadDocument>,
      crm as unknown as ActiveCampaignService,
    );

  beforeEach(() => {
    jest.useFakeTimers();
    row = {
      _id: new Types.ObjectId(),
      source: 'voice_agent',
      callerName: 'Sarah',
      callerNumber: '0412345678',
      callerEmail: 'sarah@example.com',
      eventType: 'karts',
      enquiryDetails: 'Karting for twelve',
      assignedTo: 'LeMans Inquiries',
      crmStatus: 'pending',
      crmNextAttemptAt: new Date(),
      crmAttempts: 0,
    };
    model = {
      findOneAndUpdate: jest.fn((filter, update) => ({
        exec: async () => {
          // Model the atomic claim: the update happens before another worker can claim.
          expect(filter.source).toBe('voice_agent');
          const eligible = filter.$or.some(
            (branch) =>
              row.crmStatus === branch.crmStatus &&
              (branch.crmNextAttemptAt
                ? row.crmNextAttemptAt <= branch.crmNextAttemptAt.$lte
                : row.crmLeaseUntil <= branch.crmLeaseUntil.$lte),
          );
          if (!eligible) return null;
          Object.assign(row, update.$set);
          row.crmAttempts += update.$inc.crmAttempts;
          return { ...row };
        },
      })),
      updateOne: jest.fn((filter, update) => ({
        exec: async () => {
          if (
            String(filter._id) !== String(row._id) ||
            filter.crmLeaseToken !== row.crmLeaseToken
          )
            return { matchedCount: 0 };
          Object.assign(row, update.$set);
          for (const key of Object.keys(update.$unset ?? {})) delete row[key];
          return { matchedCount: 1 };
        },
      })),
    };
    crm = {
      createContact: jest.fn(async (_payload, checkpoint) => {
        await checkpoint('42');
        return { contact: { id: '42' } };
      }),
    };
  });
  afterEach(() => jest.useRealTimers());

  it('retains failed delivery in MongoDB and a new worker resumes it on startup', async () => {
    crm.createContact.mockRejectedValueOnce(new Error('network unavailable'));
    await worker().processPending();
    expect(row).toMatchObject({
      crmStatus: 'pending',
      crmAttempts: 1,
      crmLastError: 'CRM_DELIVERY_FAILED',
    });
    expect(row.crmNextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await worker().processPending();
    expect(crm.createContact).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    const restarted = worker();
    restarted.onModuleInit();
    await restarted.processPending();
    expect(row).toMatchObject({
      crmStatus: 'synced',
      crmAttempts: 2,
      activeCampaignContactId: '42',
    });
    expect(row.crmLeaseToken).toBeUndefined();
    await restarted.beforeApplicationShutdown();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not claim an active reservation, but recovers it after a worker crashes', async () => {
    row.crmStatus = 'processing';
    row.crmLeaseToken = 'crashed-worker';
    row.crmLeaseUntil = new Date(Date.now() + 120_000);
    await worker().processPending();
    expect(crm.createContact).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(120_000);
    await worker().processPending();
    expect(row.crmStatus).toBe('synced');
    expect(crm.createContact).toHaveBeenCalledTimes(1);
  });

  it('allows only one worker to deliver a reserved lead and waits for it during shutdown', async () => {
    let finish!: () => void;
    crm.createContact.mockImplementationOnce(async (_payload, checkpoint) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await checkpoint('42');
      return { contact: { id: '42' } };
    });
    const first = worker();
    const delivery = first.processPending();
    expect(first.processPending()).toBe(delivery);
    await worker().processPending();
    expect(crm.createContact).toHaveBeenCalledTimes(1);
    let stopped = false;
    const shutdown = first.beforeApplicationShutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await Promise.all([shutdown, delivery]);
    expect(row.crmStatus).toBe('synced');
    await first.processPending();
    expect(crm.createContact).toHaveBeenCalledTimes(1);
  });

  it('reuses the checkpointed contact after a delivery acknowledgment fails', async () => {
    const normal = model.updateOne.getMockImplementation()!;
    let fail = true;
    model.updateOne.mockImplementation((filter, update) => {
      if (update.$set?.crmStatus === 'synced' && fail) {
        fail = false;
        return {
          exec: async () => {
            throw new Error('database interrupted');
          },
        };
      }
      return normal(filter, update);
    });
    await worker().processPending();
    expect(row).toMatchObject({
      crmStatus: 'pending',
      activeCampaignContactId: '42',
    });
    await jest.advanceTimersByTimeAsync(30_000);
    await worker().processPending();
    expect(crm.createContact.mock.calls[1][0].contactId).toBe('42');
    expect(row.crmStatus).toBe('synced');
  });

  it('does not mark a missing contact result as delivered', async () => {
    crm.createContact.mockResolvedValueOnce(null);
    await worker().processPending();
    expect(row.crmStatus).toBe('pending');
    expect(row.crmSyncedAt).toBeUndefined();
  });
});
