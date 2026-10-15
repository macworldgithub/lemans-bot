# Recoverable CRM delivery

Complete voice leads are finalized with `crmStatus: pending` and `crmNextAttemptAt` in the same MongoDB document update as their final details. This is an embedded outbox: saving the lead also records the obligation to deliver it. Partial leads retain the existing policy of not being sent to CRM.

`CrmDeliveryService` runs on startup, is nudged after finalization, and checks every ten seconds. It atomically reserves up to twenty jobs per batch, processing one at a time. A reservation lasts two minutes; another instance can reclaim it after a crash. Failed requests return to pending with delays of 30 seconds, 60 seconds, 120 seconds, and so on, capped at one hour. There is no retry-count cutoff. Graceful shutdown stops claiming jobs and waits for the current job.

The lead records `crmStatus` (`not_required`, `pending`, `processing`, `synced`), `crmAttempts`, `crmNextAttemptAt`, `crmLastError`, `crmSyncedAt`, and `activeCampaignContactId`. These fields also appear in the existing dashboard lead responses. Error reasons are sanitized and do not contain provider response bodies or caller details. Pending status means the database lead is saved, but CRM delivery has not yet completed.

## Configuration

Keep `ACTIVECAMPAIGN_URL` and `ACTIVECAMPAIGN_API_KEY` configured. Set these five values to the numeric IDs of the corresponding custom fields in your own ActiveCampaign account:

```dotenv
ACTIVECAMPAIGN_FIELD_EVENT_TYPE_ID=<numeric ID>
ACTIVECAMPAIGN_FIELD_EVENT_DATE_ID=<numeric ID>
ACTIVECAMPAIGN_FIELD_GROUP_SIZE_ID=<numeric ID>
ACTIVECAMPAIGN_FIELD_ENQUIRY_ID=<numeric ID>
ACTIVECAMPAIGN_FIELD_ASSIGNED_TO_ID=<numeric ID>
```

The placeholders are not usable values. Field IDs belong to your account; do not use the field titles in their place. Missing credentials or field mappings keep work pending for retry. Restart the application after changing environment settings.

Contacts with email use `/contact/sync` to update or create by email. A returned contact ID is saved before tagging; subsequent attempts update that ID. Contacts without email use the create endpoint with `allowNullEmail`. Existing tag associations are checked before applying a tag again. Tag lookup, creation, and assignment HTTP failures all fail the job and trigger retry.

## Operational limits

Delivery is at least once, not exactly once across MongoDB and ActiveCampaign. If a contact without email is created remotely and the response or local checkpoint is lost, a retry may create a duplicate because there is no saved remote ID or email identity to reuse. Email upsert and contact-ID checkpoints reduce duplicate creation but cannot make the two systems one atomic transaction.

Existing historical leads without `crmStatus: pending` are not automatically replayed. Review historical deliveries before explicitly scheduling a backfill. The schema defines indexes for pending jobs and expired reservations; provision these indexes through the normal deployment process if automatic MongoDB index creation is disabled.

Official references: [ActiveCampaign contact upsert](https://developers.activecampaign.com/reference/sync-a-contacts-data), [custom field IDs](https://developers.activecampaign.com/reference/create-a-new-contact), [Mongoose atomic findOneAndUpdate](https://mongoosejs.com/docs/tutorials/findoneandupdate).
