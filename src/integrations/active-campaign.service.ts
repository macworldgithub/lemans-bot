import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ContactPayload {
  contactId?: string;
  firstName: string;
  phone?: string;
  email?: string;
  tag?: string;
  fieldValues?: Array<{ field: string; value: string }>;
}

@Injectable()
export class ActiveCampaignService {
  private get baseUrl(): string {
    return this.config.get<string>('ACTIVECAMPAIGN_URL') ?? '';
  }

  private get apiKey(): string {
    return this.config.get<string>('ACTIVECAMPAIGN_API_KEY') ?? '';
  }

  constructor(private readonly config: ConfigService) {}

  async createContact(
    payload: ContactPayload,
    onContactSaved?: (contactId: string) => Promise<void>,
  ): Promise<any> {
    if (!this.baseUrl || !this.apiKey) {
      throw new Error('CRM_NOT_CONFIGURED');
    }
    // Keep a delivery bounded below the worker's two-minute reservation.
    const deadline = AbortSignal.timeout(60_000);

    const path = payload.contactId
      ? `/contacts/${encodeURIComponent(payload.contactId)}`
      : payload.email
        ? '/contact/sync'
        : '/contacts';
    const url = `${this.baseUrl}/api/3${path}`;

    const body = {
      contact: {
        firstName: payload.firstName,
        phone: payload.phone ?? '',
        email: payload.email ?? '',
        ...(!payload.email ? { allowNullEmail: true } : {}),
        fieldValues: (payload.fieldValues ?? []).map(({ field, value }) => {
          const id = /^\d+$/.test(field)
            ? field
            : this.config.get<string>(`ACTIVECAMPAIGN_FIELD_${field}_ID`);
          if (!id || !/^\d+$/.test(id))
            throw new Error(`CRM_FIELD_ID_MISSING: ${field}`);
          return { field: id, value };
        }),
      },
    };

    const res = await fetch(url, {
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      method: payload.contactId ? 'PUT' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Token': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`ActiveCampaign API error ${res.status}`);
    }

    const data = await res.json();
    const contactId = data?.contact?.id;
    if (!contactId) throw new Error('CRM_CONTACT_ID_MISSING');
    // Checkpoint contact creation before tagging, so retries can reuse this ID.
    await onContactSaved?.(String(contactId));

    // Tag the contact if a tag was provided
    if (contactId && payload.tag) {
      await this.tagContact(contactId, payload.tag, deadline);
    }

    return data;
  }

  private async tagContact(
    contactId: string,
    tag: string,
    deadline: AbortSignal,
  ): Promise<void> {
    // First ensure tag exists / get tag ID
    const tagId = await this.getOrCreateTag(tag, deadline);
    if (!tagId) throw new Error('CRM_TAG_ID_MISSING');

    // A previous attempt may have applied this tag before its acknowledgment was lost.
    for (let offset = 0; offset < 1000; offset += 100) {
      const existing = await fetch(
        `${this.baseUrl}/api/3/contacts/${encodeURIComponent(contactId)}/contactTags?limit=100&offset=${offset}`,
        {
          signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
          headers: { 'Api-Token': this.apiKey },
        },
      );
      if (!existing.ok)
        throw new Error(
          `ActiveCampaign contact tag lookup error ${existing.status}`,
        );
      const data = await existing.json();
      if (!Array.isArray(data.contactTags))
        throw new Error('CRM_TAG_RESPONSE_INVALID');
      if (
        data.contactTags.some(
          (item: { tag: string }) => String(item.tag) === String(tagId),
        )
      )
        return;
      if (data.contactTags.length < 100) break;
      if (offset === 900) throw new Error('CRM_TAG_LOOKUP_LIMIT');
    }

    const url = `${this.baseUrl}/api/3/contactTags`;
    const response = await fetch(url, {
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Token': this.apiKey,
      },
      body: JSON.stringify({ contactTag: { contact: contactId, tag: tagId } }),
    });
    if (!response.ok)
      throw new Error(`ActiveCampaign tagging error ${response.status}`);
  }

  private async getOrCreateTag(
    tagName: string,
    deadline: AbortSignal,
  ): Promise<string | null> {
    // Search existing tags
    const searchUrl = `${this.baseUrl}/api/3/tags?filters[tag]=${encodeURIComponent(tagName)}`;
    const res = await fetch(searchUrl, {
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      headers: { 'Api-Token': this.apiKey },
    });
    if (!res.ok)
      throw new Error(`ActiveCampaign tag lookup error ${res.status}`);
    const data = await res.json();

    const existing = data?.tags?.find(
      (tag: { tag: string }) => tag.tag === tagName,
    );
    if (existing) return existing.id;

    // Create new tag
    const createRes = await fetch(`${this.baseUrl}/api/3/tags`, {
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Token': this.apiKey,
      },
      body: JSON.stringify({ tag: { tag: tagName, tagType: 'contact' } }),
    });
    if (!createRes.ok)
      throw new Error(`ActiveCampaign tag creation error ${createRes.status}`);
    const created = await createRes.json();
    return created?.tag?.id ?? null;
  }
}
