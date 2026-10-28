import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Worker } from 'worker_threads';

const MODEL_BASE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models';

// Chosen by benchmark on real speakers (16 kHz and simulated 8 kHz phone audio):
// best same/other separation of the sherpa-onnx English models at ~28 ms per
// second of audio. Override with SPEAKER_LOCK_MODEL.
const DEFAULT_MODEL = '3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx';

// Runs inside a worker thread so embedding never blocks live audio streaming.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const sherpa = require(workerData.modulePath);
const extractor = new sherpa.SpeakerEmbeddingExtractor({
  model: workerData.modelPath,
  numThreads: workerData.numThreads,
  debug: false,
});
parentPort.postMessage({ type: 'ready', dim: extractor.dim });
parentPort.on('message', ({ id, samples }) => {
  try {
    const stream = extractor.createStream();
    stream.acceptWaveform({ samples, sampleRate: 16000 });
    stream.inputFinished();
    const embedding = Float32Array.from(extractor.compute(stream));
    parentPort.postMessage({ type: 'result', id, embedding }, [embedding.buffer]);
  } catch (err) {
    parentPort.postMessage({ type: 'result', id, error: String(err && err.message || err) });
  }
});
`;

type WorkerMessage =
  | { type: 'ready'; dim: number }
  | { type: 'result'; id: number; embedding?: Float32Array; error?: string };

export interface SpeakerVerifier {
  readonly ready: boolean;
  /** Speaker embedding for 16 kHz mono float samples. */
  embed(samples: Float32Array): Promise<Float32Array>;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Local speaker-verification engine (sherpa-onnx, no external API).
 * One worker thread holds the model and serves all calls.
 */
@Injectable()
export class SpeakerVerifierService
  implements SpeakerVerifier, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SpeakerVerifierService.name);
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (e: Float32Array) => void; reject: (e: Error) => void }
  >();
  ready = false;

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return (
      (this.config.get<string>('SPEAKER_LOCK_ENABLED') ?? 'true') !== 'false'
    );
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Speaker lock disabled (SPEAKER_LOCK_ENABLED=false)');
      return;
    }
    // Do not block app startup on the model download.
    void this.start().catch((err: Error) =>
      this.logger.error(
        `Speaker lock unavailable, calls will run without it: ${err.message}`,
      ),
    );
  }

  onModuleDestroy(): void {
    void this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }

  embed(samples: Float32Array): Promise<Float32Array> {
    if (!this.worker || !this.ready) {
      return Promise.reject(new Error('speaker verifier not ready'));
    }
    const id = this.nextId++;
    const copy = Float32Array.from(samples);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, samples: copy }, [copy.buffer]);
    });
  }

  private async start(): Promise<void> {
    const t0 = Date.now();
    const modelPath = await this.ensureModel();
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        modulePath: require.resolve('sherpa-onnx-node'),
        modelPath,
        numThreads: Number(
          this.config.get<string>('SPEAKER_LOCK_THREADS') ?? 2,
        ),
      },
    });

    await new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', (msg: WorkerMessage) => {
        if (msg.type === 'ready') {
          resolve();
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.embedding!);
      });
    });

    worker.on('error', (err) => {
      this.logger.error(`Speaker worker crashed: ${err.message}`);
      this.ready = false;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });

    this.worker = worker;
    this.ready = true;
    this.logger.log(`Speaker lock ready (${Date.now() - t0}ms)`);
  }

  private async ensureModel(): Promise<string> {
    const file = this.config.get<string>('SPEAKER_LOCK_MODEL') ?? DEFAULT_MODEL;
    const dir =
      this.config.get<string>('SPEAKER_LOCK_MODEL_DIR') ??
      join(process.cwd(), 'models', 'speaker');
    const modelPath = join(dir, file);
    if (existsSync(modelPath)) return modelPath;

    mkdirSync(dir, { recursive: true });
    const url = `${MODEL_BASE_URL}/${file}`;
    this.logger.log(`Downloading speaker model ${file} ...`);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`model download failed: HTTP ${res.status} ${url}`);
    }
    const tmp = `${modelPath}.part`;
    try {
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(tmp),
      );
      renameSync(tmp, modelPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return modelPath;
  }
}
