import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';

export interface AudioMetadata {
    duration: number;
    sampleRate: number;
    numChannels: number;
    codec: string;
    numSamples: number;
    sampleFormat: string;
    bitRate: number;
    container: string;
    fileSize: number;
}

export interface WaveformPeakLevel {
    samplesPerBucket: number;
    min: Float32Array[];
    max: Float32Array[];
}

export interface DecodedSamples {
    samples: Float32Array[];
    peakLevels: WaveformPeakLevel[];
    decodeTimeMs: number;
}

/**
 * WASM-based audio decoder service with async loading support
 */
export class AudioDecoderService {
    private static instance: AudioDecoderService;
    private wasmModule: any = null;
    private extensionPath: string;
    private isInitializing = false;
    private initPromise: Promise<any> | null = null;

    private constructor(extensionPath: string) {
        this.extensionPath = extensionPath;
    }

    public static initialize(extensionPath: string): AudioDecoderService {
        if (!AudioDecoderService.instance) {
            AudioDecoderService.instance = new AudioDecoderService(extensionPath);
        }
        return AudioDecoderService.instance;
    }

    public static getInstance(): AudioDecoderService {
        if (!AudioDecoderService.instance) {
            throw new Error('AudioDecoderService must be initialized first');
        }
        return AudioDecoderService.instance;
    }

    private async loadWasm(): Promise<any> {
        if (this.wasmModule) {
            return this.wasmModule;
        }

        if (this.isInitializing && this.initPromise) {
            return this.initPromise;
        }

        this.isInitializing = true;

        try {
            this.initPromise = this.initializeWasm();
            this.wasmModule = await this.initPromise;
            return this.wasmModule;
        } finally {
            this.isInitializing = false;
            this.initPromise = null;
        }
    }

    private async initializeWasm(): Promise<any> {
        const wasmPath = path.join(this.extensionPath, 'wasm', 'avioflow.js');
        const wasmBinaryPath = path.join(this.extensionPath, 'wasm', 'avioflow.wasm');

        if (!fs.existsSync(wasmPath)) {
            throw new Error(`WASM module not found at ${wasmPath}`);
        }

        if (!fs.existsSync(wasmBinaryPath)) {
            throw new Error(`WASM binary not found at ${wasmBinaryPath}`);
        }

        console.log('[AudioDecoderService] Loading WASM module from', wasmPath);

        const createAvioflow = await import(pathToFileURL(wasmPath).href).then(m => m.default);

        if (typeof createAvioflow !== 'function') {
            throw new Error('WASM module does not export a default initialization function');
        }

        const avioflow = await createAvioflow();
        console.log('[AudioDecoderService] WASM module loaded successfully');

        return avioflow;
    }

    public async getSupportedFileExtensions(): Promise<string[]> {
        const avioflow = await this.loadWasm();
        const extensions = new Set<string>();
        for (const formatGroup of avioflow.getSupportedInputFormats()) {
            for (const format of String(formatGroup).split(',')) {
                const extension = format.trim().toLowerCase();
                if (/^[a-z0-9]+$/.test(extension)) {
                    extensions.add(extension);
                }
            }
        }

        const decoders = new Set<string>(avioflow.getSupportedDecoders());
        if (decoders.has('opus')) extensions.add('opus');
        if (extensions.has('ogg')) extensions.add('oga');
        if (extensions.has('aiff')) {
            extensions.add('aif');
            extensions.add('aifc');
        }
        if (extensions.has('matroska')) extensions.add('mka');
        if (extensions.has('asf') || extensions.has('xwma')) extensions.add('wma');
        if (extensions.has('wav')) extensions.add('wave');

        return [...extensions].sort();
    }

    /**
     * Phase 1: Quick metadata loading (fast, ~10ms)
     */
    public async getMetadata(filePath: string): Promise<{ metadata: AudioMetadata; decoder: any; fileBuffer: Buffer }> {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Audio file not found: ${filePath}`);
        }

        const stats = fs.statSync(filePath);
        const startTime = Date.now();

        const avioflow = await this.loadWasm();
        const fileBuffer = fs.readFileSync(filePath);
        const uint8Array = new Uint8Array(fileBuffer);

        console.log(`[AudioDecoderService] Opening ${path.basename(filePath)} (${fileBuffer.length} bytes)`);

        // Create decoder instance and open buffer
        const decoder = new avioflow.AudioDecoder();
        decoder.loadBuffer(uint8Array);

        // Get metadata only (fast)
        const metaStart = Date.now();
        const rawMeta = decoder.getMetadata();
        const metaTime = Date.now() - metaStart;

        const metadata: AudioMetadata = {
            duration: rawMeta.duration,
            sampleRate: rawMeta.sampleRate,
            numChannels: rawMeta.numChannels,
            codec: rawMeta.codec,
            numSamples: rawMeta.numSamples,
            sampleFormat: rawMeta.sampleFormat,
            bitRate: rawMeta.bitRate,
            container: rawMeta.container,
            fileSize: stats.size
        };

        console.log(`[AudioDecoderService] Metadata loaded in ${metaTime}ms (total: ${Date.now() - startTime}ms)`);

        return { metadata, decoder, fileBuffer };
    }

    /**
     * Bucket sizes (samples per bucket) for the waveform peak levels,
     * ascending. Rendering picks the coarsest level that's still finer than
     * the current on-screen samples-per-pixel, so this range has to span from
     * "fully zoomed in" (fall back to raw samples) to "fully zoomed out".
     */
    private static readonly PEAK_BUCKET_SIZES = [64, 512, 4096, 32768, 262144];

    /**
     * Phase 2: Decode all samples (slow, async), plus min/max peak levels for
     * fast waveform rendering at any zoom level without rescanning raw
     * samples in JS.
     */
    public async getSamples(decoder: any, startSeconds = 0, stopSeconds = -1): Promise<DecodedSamples> {
        const startTime = Date.now();

        console.log('[AudioDecoderService] Starting sample decoding...');

        // This is the slow operation
        const samples = decoder.getSamples(startSeconds, stopSeconds);
        const decodeTimeMs = Date.now() - startTime;

        console.log(`[AudioDecoderService] Samples decoded in ${decodeTimeMs}ms`);

        // Convert to array
        const samplesArray: Float32Array[] = [];
        for (let i = 0; i < samples.length; i++) {
            samplesArray.push(samples[i]);
        }

        const peakLevels = AudioDecoderService.buildPeakLevels(samplesArray);

        return { samples: samplesArray, peakLevels, decodeTimeMs };
    }

    public async getSamplesRange(fileBuffer: Buffer, startSeconds: number, stopSeconds: number): Promise<DecodedSamples> {
        const avioflow = await this.loadWasm();
        const decoder = new avioflow.AudioDecoder();
        decoder.loadBuffer(new Uint8Array(fileBuffer));
        try {
            return await this.getSamples(decoder, startSeconds, stopSeconds);
        } finally {
            if (typeof decoder.delete === 'function') decoder.delete();
            else if (typeof decoder.dispose === 'function') decoder.dispose();
        }
    }

    private static buildPeakLevels(samples: Float32Array[]): WaveformPeakLevel[] {
        const numChannels = samples.length;
        if (numChannels === 0) {
            return [];
        }

        const levels: WaveformPeakLevel[] = [];
        let prevMin: Float32Array[] | null = null;
        let prevMax: Float32Array[] | null = null;
        let prevBucketSize = 1;

        for (const bucketSize of AudioDecoderService.PEAK_BUCKET_SIZES) {
            const min: Float32Array[] = new Array(numChannels);
            const max: Float32Array[] = new Array(numChannels);
            const group = Math.max(1, Math.floor(bucketSize / prevBucketSize));

            for (let c = 0; c < numChannels; c++) {
                const source: ArrayLike<number> = prevMin ? prevMin[c] : samples[c];
                const sourceMax: ArrayLike<number> = prevMax ? prevMax[c] : samples[c];
                const numBuckets = Math.ceil(source.length / group);
                const bucketMin = new Float32Array(numBuckets);
                const bucketMax = new Float32Array(numBuckets);

                for (let b = 0; b < numBuckets; b++) {
                    const start = b * group;
                    const stop = Math.min(start + group, source.length);
                    let bMin = Number.POSITIVE_INFINITY;
                    let bMax = Number.NEGATIVE_INFINITY;
                    for (let i = start; i < stop; i++) {
                        const lo = source[i];
                        const hi = sourceMax[i];
                        if (lo < bMin) bMin = lo;
                        if (hi > bMax) bMax = hi;
                    }
                    bucketMin[b] = bMin;
                    bucketMax[b] = bMax;
                }

                min[c] = bucketMin;
                max[c] = bucketMax;
            }

            levels.push({ samplesPerBucket: bucketSize, min, max });
            prevMin = min;
            prevMax = max;
            prevBucketSize = bucketSize;
        }

        return levels;
    }

    /**
     * Legacy: Decode everything at once (for backwards compatibility)
     */
    public async decodeAudioFile(filePath: string): Promise<{ metadata: AudioMetadata; samples: Float32Array[]; peakLevels: WaveformPeakLevel[]; loadTimeMs: number }> {
        const { metadata, decoder } = await this.getMetadata(filePath);
        const { samples, peakLevels, decodeTimeMs } = await this.getSamples(decoder, 0, -1);

        return {
            metadata,
            samples,
            peakLevels,
            loadTimeMs: decodeTimeMs
        };
    }

    public dispose() {
        this.wasmModule = null;
        console.log('[AudioDecoderService] Disposed');
    }
}
