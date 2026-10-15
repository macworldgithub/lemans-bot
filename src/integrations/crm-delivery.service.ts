import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { LeadDocument, VOICE_LEAD_MODEL } from '../voice/schemas/lead.schema';
import { ActiveCampaignService } from './active-campaign.service';

const TAGS: Record<string, string> = {
  kids_party: 'KidsParty',
  teen_party: 'TeenParty',
  buck_party: 'BucksHens',
  corporate: 'Corporate',
  adult_party: 'AdultParty',
  karts: 'Karts',
  vr: 'VR',
  activities: 'Activities',
  booking_change: 'BookingChange',
  complaint: 'Complaint',
  after_hours: 'AfterHours',
  school_group: 'SchoolGroup',
  emergency: 'Emergency',
  general_enquiry: 'GeneralEnquiry',
  unknown: 'Unknown',
};

/** The finalized lead doubles as a durable outbox; no separate queue is required. */
@Injectable()
export class CrmDeliveryService
  implements OnModuleInit, BeforeApplicationShutdown
{
  private readonly logger = new Logger(CrmDeliveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;

  constructor(
    @InjectModel(VOICE_LEAD_MODEL) private readonly leads: Model<LeadDocument>,
    private readonly activeCampaign: ActiveCampaignService,
  ) {}

  onModuleInit(): void {
    this.wake();
    this.timer = setInterval(() => this.wake(), 10_000);
    this.timer.unref();
  }

  wake(): void {
    void this.processPending().catch(() => {
      this.logger.warn(
        'CRM delivery deferred; pending work remains in MongoDB',
      );
    });
  }

  processPending(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.deliverBatch().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    // Finish the current request while MongoDB is still available. Unclaimed work stays durable.
    await this.running?.catch(() => {});
  }

  private async deliverBatch(): Promise<void> {
    for (let i = 0; i < 20 && !this.stopping; i++) {
      const now = new Date();
      const token = randomUUID();
      const lead = await this.leads
        .findOneAndUpdate(
          {
            source: 'voice_agent',
            $or: [
              { crmStatus: 'pending', crmNextAttemptAt: { $lte: now } },
              { crmStatus: 'processing', crmLeaseUntil: { $lte: now } },
            ],
          },
          {
            $set: {
              crmStatus: 'processing',
              crmLeaseToken: token,
              crmLeaseUntil: new Date(now.getTime() + 120_000),
            },
            $inc: { crmAttempts: 1 },
          },
          {
            returnDocument: 'after',
            sort: { crmNextAttemptAt: 1 },
            maxTimeMS: 10_000,
          },
        )
        .exec();
      if (!lead) return;
      const owned = { _id: lead._id, crmLeaseToken: token };
      try {
        const response = await this.activeCampaign.createContact(
          {
            contactId: lead.activeCampaignContactId,
            firstName: lead.callerName!,
            phone: lead.callerNumber,
            email: lead.callerEmail || undefined,
            tag: TAGS[lead.eventType],
            fieldValues: [
              { field: 'EVENT_TYPE', value: lead.eventType },
              { field: 'EVENT_DATE', value: lead.eventDate ?? '' },
              { field: 'GROUP_SIZE', value: String(lead.groupSize ?? '') },
              { field: 'ENQUIRY', value: lead.enquiryDetails ?? '' },
              { field: 'ASSIGNED_TO', value: lead.assignedTo },
            ],
          },
          async (contactId) => {
            const result = await this.leads
              .updateOne(owned, {
                $set: { activeCampaignContactId: contactId },
              })
              .exec();
            if (!result.matchedCount) throw new Error('CRM_LEASE_LOST');
          },
        );
        if (!response?.contact?.id) throw new Error('CRM_CONTACT_ID_MISSING');
        await this.leads
          .updateOne(owned, {
            $set: { crmStatus: 'synced', crmSyncedAt: new Date() },
            $unset: {
              crmLeaseToken: 1,
              crmLeaseUntil: 1,
              crmNextAttemptAt: 1,
              crmLastError: 1,
            },
          })
          .exec();
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const reason = /^CRM_[A-Z_]+(?:: [A-Z_]+)?$/.test(message)
          ? message
          : 'CRM_DELIVERY_FAILED';
        const delay = Math.min(
          3_600_000,
          30_000 * 2 ** Math.min(lead.crmAttempts - 1, 7),
        );
        await this.leads
          .updateOne(owned, {
            $set: {
              crmStatus: 'pending',
              crmNextAttemptAt: new Date(Date.now() + delay),
              crmLastError: reason,
            },
            $unset: { crmLeaseToken: 1, crmLeaseUntil: 1 },
          })
          .exec();
        this.logger.warn(`CRM delivery will retry; lead_id=${lead._id}`);
      }
    }
  }
}
