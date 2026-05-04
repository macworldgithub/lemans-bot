import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ContactPayload {
  firstName: string;
  phone?: string;
  tag?: string;
  fieldValues?: Array<{ field: string; value: string }>;
}

@Injectable()
export class ActiveCampaignService {
  private readonly logger = new Logger(ActiveCampaignService.name);

  private get baseUrl(): string {
    return this.config.get<string>('ACTIVECAMPAIGN_URL') ?? '';
  }

  private get apiKey(): string {
    return this.config.get<string>('ACTIVECAMPAIGN_API_KEY') ?? '';
  }

  constructor(private readonly config: ConfigService) {}

  async createContact(payload: ContactPayload): Promise<any> {
    if (!this.baseUrl || !this.apiKey) {
      this.logger.warn('ActiveCampaign not configured — skipping contact creation');
      return null;
    }

    const url = `${this.baseUrl}/api/3/contacts`;

    const body = {
      contact: {
        firstName: payload.firstName,
        phone: payload.phone ?? '',
        fieldValues: payload.fieldValues ?? [],
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Token': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ActiveCampaign API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    const contactId = data?.contact?.id;

    // Tag the contact if a tag was provided
    if (contactId && payload.tag) {
      await this.tagContact(contactId, payload.tag);
    }

    return data;
  }

  private async tagContact(contactId: string, tag: string): Promise<void> {
    // First ensure tag exists / get tag ID
    const tagId = await this.getOrCreateTag(tag);
    if (!tagId) return;

    const url = `${this.baseUrl}/api/3/contactTags`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Token': this.apiKey,
      },
      body: JSON.stringify({ contactTag: { contact: contactId, tag: tagId } }),
    });
  }

  private async getOrCreateTag(tagName: string): Promise<string | null> {
    try {
      // Search existing tags
      const searchUrl = `${this.baseUrl}/api/3/tags?search=${encodeURIComponent(tagName)}`;
      const res = await fetch(searchUrl, {
        headers: { 'Api-Token': this.apiKey },
      });
      const data = await res.json();

      if (data?.tags?.length > 0) {
        return data.tags[0].id;
      }

      // Create new tag
      const createRes = await fetch(`${this.baseUrl}/api/3/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Token': this.apiKey,
        },
        body: JSON.stringify({ tag: { tag: tagName, tagType: 'contact' } }),
      });
      const created = await createRes.json();
      return created?.tag?.id ?? null;
    } catch (err) {
      this.logger.warn(`Failed to get/create tag "${tagName}": ${err.message}`);
      return null;
    }
  }
}