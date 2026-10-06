# Voice agent update report

## What was fixed

The agent now has a backend that runs the `save_lead` tool, extracts information from the conversation, and writes the result to MongoDB. Every started call gets its own record, even if the caller never gives their name or number. Corrections update that same record. Ending the call triggers a final save.

The spoken voice model is still `gpt-live-1`. The separate model used to extract lead information defaults to `gpt-6-luna`, configurable through `OPENAI_LEAD_MODEL`. Both use `OPENAI_API_KEY`.

## How a call now works

1. **Call starts:** create a partial record in MongoDB's existing `leads` collection.
2. **Conversation happens:** collect both the caller's words and the agent's words. Save raw context periodically during the call.
3. **The voice model delegates:** the backend sends that context to the extraction model with the `save_lead` tool attached.
4. **The extraction model returns fields:** validate the name, phone, email, event, date, group size, enquiry, and language before saving.
5. **Caller corrects something:** update the same record using its stable MongoDB ID.
6. **Call ends:** attempt final extraction, save the transcript and end time, and then notify the browser that the call has ended.

If extraction fails, the raw conversation is still saved and the record marks extraction as failed. If final database saving fails, the application retries three times, five seconds apart.

## Changes in each application file

### `src/voice/lead-capture.service.ts` — new file

This is the main component responsible for saving calls. Previously, extraction and saving were mixed into the voice service. This file now owns:

- Creating one record per call, including silent and incomplete calls.
- Collecting both speakers' transcripts and periodically saving them.
- Calling the extraction model with the strict `save_lead` tool.
- Understanding short answers, spoken phone digits, and later corrections through model context instead of regular expressions.
- Checking returned fields before saving them.
- Updating an existing record instead of creating duplicates during a call.
- Final saving, database retries, and graceful shutdown handling.
- Attempting ActiveCampaign contact creation after a complete lead is finalized.

### `src/voice/voice.service.ts`

This file manages the browser call's connection to the voice model.

- Replaced the old regex extraction and first-save-only behavior with calls to `LeadCaptureService`.
- Sends both caller and assistant transcripts to the capture service.
- Processes repeated delegations so corrections can be saved.
- Returns a confirmed backend result to the voice model before it claims information was logged.
- Creates capture state when the actual call starts; simply preparing the connection does not create a lead.
- Waits briefly for pending final transcripts when ending a call, then awaits persistence.
- Handles provider disconnects and closes active browser sessions during graceful shutdown.
- Added startup timeout and guards for connections that close during startup.

### `src/voice/lemans-knowledge.ts`

This file contains the agent instructions and tool definition.

- Updated instructions to delegate when details arrive or change.
- Instructed the agent to claim a save only after confirmation.
- Made `save_lead` use a strict schema: all expected fields must be present, unknown values may be null, and unexpected fields are rejected.
- Added constraints such as a positive whole number for group size.

### `src/voice/schemas/lead.schema.ts`

This file defines the MongoDB document structure.

- Allows a missing caller name so incomplete calls can be saved.
- Added `captureStatus`: partial or complete.
- Added `extractionStatus`: pending, complete, or failed.
- Added caller transcript, both speakers' conversation, language, start time, and end time.
- Uses the model name `VoiceLead` to avoid a conflict with the separate tradie `Lead` model.
- Keeps the existing `leads` collection; historical records are not rewritten.
- Disables Mongoose command buffering for this schema so disconnected writes report failure instead of sitting in its buffer.

### `src/voice/voice.module.ts`

Registers the new capture service and the `VoiceLead` database model so NestJS can inject them into the voice components.

### `src/voice/voice.gateway.ts`

This file handles messages between the browser and server.

- Awaits final saving when the browser sends End Call.
- Starts finalization on browser disconnect and session timeout.
- Handles failures from asynchronous connection preparation and closing.
- Avoids duplicate call-ended notifications.
- Sends an error when ending fails, allowing the user to retry.

### `public/index.html`

This is the browser demo interface.

- End Call stops microphone input and playback, then shows a saving state.
- Waits for server confirmation before showing that the call ended.
- Shows whether the saved record is partial or complete and displays its ID.
- Keeps the saved notification visible after the call ends.
- Uses plain text for the saved-lead message.
- Removed the premature claim that the contact was synced to ActiveCampaign.
- Allows retrying End Call if saving reports an error.

### `src/ari/ari.service.ts`

This file handles telephone calls through ARI.

- Starts lead capture when the voice session is ready.
- Passes both speakers' transcripts to the same capture service used by browser calls.
- Runs final capture during telephone call cleanup and hangup.

### `src/dashboard/dashboard.module.ts`

Registers the dashboard against the `VoiceLead` model name so it uses the intended voice schema.

### `src/dashboard/dashboard.service.ts`

Injects `VoiceLead` instead of the conflicting generic `Lead` model. Dashboard queries still use the existing collection.

### `src/main.ts`

Enables NestJS shutdown hooks so graceful server shutdown can close calls and finalize their records.

## Changes in test files

| File | What changed |
| --- | --- |
| `src/voice/lead-capture.service.spec.ts` — new | Tests tool configuration, transcript context, corrections, distinct calls, incomplete calls, final saving, extraction failures, database retries, shutdown, and schema separation. OpenAI and database operations are mocked here. |
| `src/voice/voice-lifecycle.spec.ts` — new | Tests browser call preparation, transcript collection, repeated delegation, final transcript draining, provider disconnect, and waiting for persistence before the closed notification. |
| `src/voice/voice.service.spec.ts` | Added the capture-service mock needed by the existing service construction test. |
| `src/ari/ari.service.spec.ts` | Added mocks for the new external-session capture methods. |
| `src/dashboard/dashboard.service.spec.ts` | Updated the mocked database model token to `VoiceLead`. |

## Documentation files

| File | Purpose |
| --- | --- |
| `Docs/voice-lead-capture.md` — new | Explains configuration, persistence behavior, verification steps, and remaining limits. |
| `Docs/voice-update-report.md` — new | This file: explains each change in plain language and records verification results. |

No application files in `src/voice-agent/` were changed for these fixes. The affected browser voice path is in `src/voice/`, with telephone integration in `src/ari/`.

## What was verified on 6 October 2026

- **TypeScript compilation:** passed.
- **Automated tests:** all 41 tests across 11 suites passed.
- **Browser script syntax:** passed.
- **Updated OpenAI key:** successfully called the real extraction model.
- **Real extraction:** understood the short name reply Sarah and converted spoken digits to `0412345678`.
- **Corrections:** changed the group from 12 to 15 and the date from 20 to 21 November 2026 while preserving the same lead ID. This extraction check used mocked database writes.
- **MongoDB connection:** successfully connected and received a successful ping.
- **Actual MongoDB final save:** a separate temporary incomplete session was finalized through the capture service. Reading MongoDB confirmed one partial record with completed extraction, a caller transcript, and an end timestamp.
- **Cleanup:** removed that temporary database record after verification.

## What this means for running the app

With working credentials and MongoDB available, the implemented call paths now save a lead record when a call starts, update it during the conversation, and finalize it when the call ends. A partial record means some caller details are missing; it does not mean the save failed.

Restart an already-running dev server after changing `.env` so it reads the updated key.

These checks verify extraction and actual persistence, but they do not prove the entire deployment is production ready. A real microphone/browser call and a real ARI telephone call still need end-to-end verification. ActiveCampaign delivery was not verified. An abrupt process kill can lose the latest unsaved transcript fragments, and the retry state is in memory rather than a durable queue.
