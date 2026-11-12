# Chloe upgrade release notes

## Behavior

- Routine casual bookings go to the booking website. Eligible events, booking support and complaints use the approved staff path or a truthful fallback.
- Hours are returned only from a valid, current snapshot. The live Google source remains a separate setup task.
- Call state tracks request changes, transfer ownership and pending actions. Entry routes are blocked as transfer destinations.
- The live greeting waits for its speech request to finish. It permits one retry only after a confirmed failure, before either party speaks. There is no repeating greeting timer.
- Live response timing starts when caller audio stops. Late transcript fragments cannot start more timers. A slow live reply is logged without interrupting the answer or adding fallback speech. Three seconds remains a target, not a guaranteed response time.
- Chloe answers known activity and package questions before offering a website or staff transfer. She can give more detail on request. Missing facts do not cancel the known parts of an answer.
- Internal message routes validate call scope, review evidence and consent. Unknown provider results remain unknown.
- Cascade-mode web calls can simulate an approved SMS after the call ends. The final approved draft is selected at confirmed disconnect. Duplicate completion requests reuse the stored operation.
- Real SMS remains disabled. A real provider and verified voice-mode binding are required before activation.
- Private call, lead and monitor routes require staff access configuration in production. Without it, those routes return a refusal. Do not weaken this check to make a monitor test pass.

## Verification

The initial release passed 108 backend tests. The speech fix adds event-order tests for late transcripts, slow replies, caller interruptions, session close and greeting failures. It also adds prompt checks and two real-model text checks for party information. These text checks do not prove live phone audio.

The local OpenAI credential was rejected during a later voice connection check. That local credential is not part of the release. Local startup checks do not establish working audio. The user requested deployment with the existing server environment unchanged.

## Deployment constraints

- Keep the server `.env` file unchanged. Do not copy a local environment file or replace existing keys.
- Deploy the exact published commit. Build before restarting the API and agent.
- Keep Asterisk, LiveKit, SIP and routing configuration unchanged.
- Keep a rollback copy of replaced files and compiled output. Restart only when no call is active.
- Verify API health, worker registration, process stability and an unchanged environment-file checksum after deployment.
- A real phone call is still needed to verify greeting, two-way audio, interruption and clean hang-up. SMS delivery, staff transfer completion, current hours and production transaction capability remain separate checks.
