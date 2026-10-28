<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Tradie AI Voice Notes

- ARI bridge status endpoint: `GET /ari/health`
- Phase 1 deployment runbook: `Docs/phase-1-asterisk-ari-setup.md`
- Live transcript of every call (web + phone): `/monitor.html`

### Speaker lock

The bot locks onto the voice of the first person who speaks and ignores other voices
(people in the room, TV, speakerphone echo). Runs locally with
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), no extra API or key.

- OpenAI server VAD still finds turns, but with `create_response: false`; each turn is
  scored against the caller's voiceprint (built from their first ~1.5 s of speech, refined
  up to 8 s). Match → `response.create`. No match → the turn is deleted from the
  conversation, so the model never sees it. Barge-in waits ~0.8 s for verification.
- The model (~26 MB) downloads to `models/speaker/` on first start. If it is missing or
  fails, calls run exactly as before (fail open).
- `/monitor.html` shows the verdict and similarity score on every caller turn.

| Env var | Default | Notes |
| --- | --- | --- |
| `SPEAKER_LOCK_ENABLED` | `true` | `false` restores the old behaviour |
| `SPEAKER_LOCK_THRESHOLD` | `0.40` | web: similarity needed for turns ≥ 1.5 s |
| `SPEAKER_LOCK_SHORT_THRESHOLD` | `0.22` | web: needed at 0.6 s, rising linearly to the threshold |
| `SPEAKER_LOCK_PHONE_THRESHOLD` | `0.50` | phone (8 kHz audio separates voices less) |
| `SPEAKER_LOCK_PHONE_SHORT_THRESHOLD` | `0.32` | phone, short turns |
| `SPEAKER_LOCK_MIN_VERIFY_SEC` | `0.6` | shorter turns are let through unchecked |
| `SPEAKER_LOCK_BARGE_IN_MS` | `800` | speech needed before the bot is cut off |
| `SPEAKER_LOCK_ENROLL_SEC` | `1.5` | caller speech needed before the lock engages |
| `SPEAKER_LOCK_MODEL` | `3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx` | any sherpa-onnx speaker model |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` | voice brain (Realtime API, WebSocket) |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-live-transcribe` | caller transcript for the monitor (`gpt-4o-transcribe` shuts down 2027-02-26) |

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
