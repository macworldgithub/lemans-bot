import { ConfigService } from '@nestjs/config';
import { ActiveCampaignService } from './active-campaign.service';

describe('ActiveCampaign retry behavior', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let service: ActiveCampaignService;
  const response = (body: object, status = 200) =>
    new Response(JSON.stringify(body), { status });
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
    service = new ActiveCampaignService(
      new ConfigService({
        ACTIVECAMPAIGN_URL: 'https://crm.example.com',
        ACTIVECAMPAIGN_API_KEY: 'test-key',
        ACTIVECAMPAIGN_FIELD_EVENT_TYPE_ID: '7',
      }),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('upserts by email and uses numeric custom field IDs', async () => {
    fetchMock.mockResolvedValueOnce(response({ contact: { id: '42' } }));
    const checkpoint = jest.fn().mockResolvedValue(undefined);
    await service.createContact(
      {
        firstName: 'Sarah',
        email: 'sarah@example.com',
        fieldValues: [{ field: 'EVENT_TYPE', value: 'karts' }],
      },
      checkpoint,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://crm.example.com/api/3/contact/sync',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.contact.fieldValues).toEqual([{ field: '7', value: 'karts' }]);
    expect(checkpoint).toHaveBeenCalledWith('42');
  });

  it('checkpoints a created contact before a tagging failure and retries using that contact', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ contact: { id: '42' } }))
      .mockResolvedValueOnce(response({ tags: [{ id: '9', tag: 'Karts' }] }))
      .mockResolvedValueOnce(response({ contactTags: [] }))
      .mockResolvedValueOnce(response({}, 503));
    const checkpoint = jest.fn().mockResolvedValue(undefined);
    await expect(
      service.createContact({ firstName: 'Sarah', tag: 'Karts' }, checkpoint),
    ).rejects.toThrow('tagging error 503');
    expect(checkpoint).toHaveBeenCalledWith('42');
    const created = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(created.contact.allowNullEmail).toBe(true);

    fetchMock
      .mockResolvedValueOnce(response({ contact: { id: '42' } }))
      .mockResolvedValueOnce(response({ tags: [{ id: '9', tag: 'Karts' }] }))
      .mockResolvedValueOnce(response({ contactTags: [] }))
      .mockResolvedValueOnce(response({}));
    await service.createContact(
      { contactId: '42', firstName: 'Sarah', tag: 'Karts' },
      checkpoint,
    );
    expect(fetchMock.mock.calls[4]).toEqual([
      'https://crm.example.com/api/3/contacts/42',
      expect.objectContaining({ method: 'PUT' }),
    ]);
  });

  it('reports missing configuration instead of silently skipping delivery', async () => {
    const unconfigured = new ActiveCampaignService(new ConfigService({}));
    await expect(
      unconfigured.createContact({ firstName: 'Sarah' }),
    ).rejects.toThrow('CRM_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not apply a tag again when an earlier attempt already applied it', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ contact: { id: '42' } }))
      .mockResolvedValueOnce(response({ tags: [{ id: '9', tag: 'Karts' }] }))
      .mockResolvedValueOnce(response({ contactTags: [{ tag: '9' }] }));
    await service.createContact({
      contactId: '42',
      firstName: 'Sarah',
      tag: 'Karts',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/contactTags'),
      ),
    ).toBe(false);
  });

  it('keeps invalid custom field configuration from sending a broken request', async () => {
    await expect(
      service.createContact({
        firstName: 'Sarah',
        fieldValues: [{ field: 'ENQUIRY', value: 'Karting' }],
      }),
    ).rejects.toThrow('CRM_FIELD_ID_MISSING: ENQUIRY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a tag lookup HTTP failure so the durable worker can retry', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ contact: { id: '42' } }))
      .mockResolvedValueOnce(response({}, 503));
    await expect(
      service.createContact({ firstName: 'Sarah', tag: 'Karts' }),
    ).rejects.toThrow('tag lookup error 503');
  });
});
