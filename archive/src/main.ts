import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

function printStartupBanner(config: ConfigService, port: number) {
  const get = (key: string, fallback: string) =>
    config.get<string>(key) ?? fallback;

  const architecture = get('VOICE_ARCHITECTURE', 'gpt-live');
  const rows: [string, string][] = [
    ['Architecture', architecture],
    ['Brain (LLM)', get('OPENAI_REALTIME_MODEL', 'gpt-realtime-2.1')],
    ['STT', get('OPENAI_TRANSCRIBE_MODEL', 'gpt-live-transcribe')],
    ...(architecture === 'sandwich'
      ? ([
          ['TTS model', get('ELEVENLABS_MODEL_ID', 'eleven_turbo_v2_5')],
          ['TTS voice id', get('ELEVENLABS_VOICE_ID', '(not set)')],
        ] as [string, string][])
      : ([
          ['TTS (OpenAI voice)', `${get('OPENAI_LIVE_VOICE', 'marin')} (pace ${get('OPENAI_LIVE_SPEAKING_PACE', 'brisk')})`],
        ] as [string, string][])),
    ['Backend (HTTP/WS)', `http://localhost:${port}`],
    ['Frontend (static)', `http://localhost:${port}/  (monitor: /monitor.html)`],
    ['Swagger', `http://localhost:${port}/swagger`],
    ['ARI WebSocket', `ws port ${get('WEBSOCKET_PORT', '9090')}`],
    [
      'Asterisk ARI',
      `${get('ASTERISK_ARI_URL', 'http://127.0.0.1:8088')} (app ${get('ASTERISK_ARI_APP', 'ai-bridge')})`,
    ],
    [
      'RTP media',
      `${get('ASTERISK_EXTERNAL_MEDIA_BIND_HOST', '0.0.0.0')}:${get('ASTERISK_EXTERNAL_MEDIA_BIND_PORT', '6000')}`,
    ],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, value]) => `  ${label.padEnd(width)} : ${value}`);
  const bar = '='.repeat(Math.max(...lines.map((l) => l.length)) + 2);
  console.log(['', bar, '  LEMANS BOT STARTED', bar, ...lines, bar, ''].join('\n'));
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? 5000;

  // Enable CORS
  app.enableCors();

  // Global validation pipe for DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger Configuration
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Tradie Voice Agent API')
    .setDescription('Authentication & Voice Agent System Documentation')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('swagger', app, document);

  app.useStaticAssets(join(__dirname, '..', 'public'));

  await app.listen(port);
  console.log(`Server running on http://localhost:${port}`);
  printStartupBanner(config, port);
}
void bootstrap();
