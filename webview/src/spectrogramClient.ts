import SpectrogramWorker from "./spectrogram.worker?worker&inline";
import { computeSpectrogramPixels, type SpectrogramOptions } from "./spectrogram";

export interface SpectrogramResult<Meta> {
    channel: number;
    options: SpectrogramOptions;
    meta: Meta;
    pixels: Uint8ClampedArray;
}

interface PendingRequest<Meta> {
    options: SpectrogramOptions;
    meta: Meta;
}

/**
 * Computes spectrogram tiles off the main thread. At most one request per
 * channel is in flight; newer requests replace any that are still waiting, so
 * fast scrolling or zooming never builds up a backlog. Falls back to
 * computing on the main thread if the worker cannot be created.
 */
export class SpectrogramClient<Meta> {
    private worker: Worker | null = null;
    private channels: Float32Array[] = [];
    private version = 0;
    private inFlight = new Set<number>();
    private pending = new Map<number, PendingRequest<Meta>>();

    constructor(private readonly onResult: (result: SpectrogramResult<Meta>) => void) {
        try {
            this.worker = new SpectrogramWorker();
            this.worker.onmessage = (event: MessageEvent) => this.finish(event.data);
            this.worker.onerror = () => {
                this.worker?.terminate();
                this.worker = null;
                this.inFlight.clear();
            };
        } catch {
            this.worker = null;
        }
    }

    setData(channels: Float32Array[]): void {
        this.version++;
        this.channels = channels;
        this.pending.clear();
        if (this.worker) {
            // Copy so the main thread keeps its own samples for playback and the waveform.
            const copies = channels.map((channel) => channel.slice());
            this.worker.postMessage({ type: "data", version: this.version, channels: copies }, copies.map((copy) => copy.buffer));
        }
    }

    request(channel: number, options: SpectrogramOptions, meta: Meta): void {
        this.pending.set(channel, { options, meta });
        this.pump(channel);
    }

    dispose(): void {
        this.worker?.terminate();
        this.worker = null;
        this.pending.clear();
        this.inFlight.clear();
    }

    private pump(channel: number): void {
        if (this.inFlight.has(channel)) return;
        const next = this.pending.get(channel);
        if (!next) return;
        this.pending.delete(channel);
        this.inFlight.add(channel);
        const version = this.version;

        if (this.worker) {
            this.worker.postMessage({ type: "render", version, channel, options: next.options, meta: next.meta });
        } else {
            setTimeout(() => {
                const data = this.channels[channel];
                const pixels = data
                    ? computeSpectrogramPixels(data, next.options)
                    : new Uint8ClampedArray(next.options.width * next.options.height * 4);
                this.finish({ version, channel, options: next.options, meta: next.meta, pixels });
            }, 0);
        }
    }

    private finish(message: { version: number; channel: number; options: SpectrogramOptions; meta: Meta; pixels: Uint8ClampedArray }): void {
        this.inFlight.delete(message.channel);
        if (message.version === this.version) {
            this.onResult({ channel: message.channel, options: message.options, meta: message.meta, pixels: message.pixels });
        }
        this.pump(message.channel);
    }
}
