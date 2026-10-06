# Voice lead capture

Every started browser call and ready ARI voice session creates a partial record in MongoDB's existing `leads` collection. Connecting a demo page and prewarming OpenAI alone does not create a record. Each browser call gets a distinct call ID, even when the same Socket.IO connection is reused.

The voice model remains `gpt-live-1` with client delegation. `LeadCaptureService` runs an OpenAI Responses backend with the strict `save_lead` function registered and selected. Set `OPENAI_LEAD_MODEL` to choose this backend model; its default is `gpt-6-luna`. The backend uses the existing `OPENAI_API_KEY`. This adds Responses API usage on delegation and final extraction.

Restart the dev server after changing `.env` credentials or model settings.

Both caller and assistant transcripts are supplied as context so the backend can understand short answers, spoken phone numbers, and corrections. Tool arguments are validated before updating the record. Missing information stays null, and incomplete records have `captureStatus: partial`. Records also include `callerTranscript`, the conversation, timestamps, and `extractionStatus`.

Raw context is saved during calls. Repeated delegations update the same record using its stable MongoDB `_id`. On End Call, browser disconnect, provider closure, silence timeout, ARI hangup, or graceful server shutdown, capture performs final persistence. A short browser transcription drain allows pending final transcript fragments to arrive. If final extraction fails, the raw transcript is retained with `extractionStatus: failed`. Temporary final database failures are retried three times with five-second delays using the same record ID.

The UI waits for final database persistence before showing Call ended and keeps the saved ID visible. It does not claim ActiveCampaign sync has succeeded. CRM creation is attempted once at finalization for complete leads; its returned contact ID is stored when available.

The voice schema uses the `VoiceLead` model token, distinct from the tradie module's `Lead`, while retaining the existing collection. This avoids accidentally validating voice payloads against the tradie schema. Historical documents are not rewritten.

## Verification

Run `npx tsc --noEmit --incremental false` and `npx jest --runInBand`.

For a real call, start the dev server, open the web demo, and try:

1. Give only your first name after the agent asks for your name, then speak a callback number digit by digit.
2. Correct the date or headcount after the first save. End the call and check that the same lead ID contains the correction.
3. End another call before supplying contact details. Confirm a distinct partial record and transcript were saved.
4. Close the browser tab mid-call and confirm the record has an end timestamp.

A database operation succeeding is required before a saved notification is emitted. Conversation promises alone do not prove persistence. Automated tests mock OpenAI and MongoDB; validate actual model access and extraction quality with real calls before deployment.

Periodic raw persistence reduces loss, but an abrupt process kill can lose the most recent unsaved fragments. Three failed retries retain state in memory; a prolonged database outage combined with a process restart needs a durable retry queue. Existing deployment authentication and access-control concerns are outside this change.
