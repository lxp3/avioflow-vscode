export type FrequencyScale = "linear" | "log" | "mel";

/** Same formula as Audacity's Mel scale. */
export const hzToMel = (hz: number): number => 1127 * Math.log(1 + hz / 700);
export const melToHz = (mel: number): number => 700 * (Math.exp(mel / 1127) - 1);

export interface FrequencyAxis {
    lowHz: number;
    highHz: number;
    /** Frequency at `fraction` of the axis height (0 = bottom, 1 = top). */
    frequencyAt(fraction: number): number;
    /** Inverse of `frequencyAt`. */
    fractionOf(hz: number): number;
}

export function createFrequencyAxis(sampleRate: number, scale: FrequencyScale, minFrequency: number, maxFrequency: number): FrequencyAxis {
    const nyquist = sampleRate / 2;
    const highHz = Math.max(1, Math.min(maxFrequency > 0 ? maxFrequency : nyquist, nyquist));
    if (scale === "log") {
        const lowHz = Math.min(Math.max(1, minFrequency), highHz / 10);
        const ratio = Math.log(highHz / lowHz);
        return {
            lowHz,
            highHz,
            frequencyAt: (fraction) => lowHz * Math.exp(ratio * fraction),
            fractionOf: (hz) => Math.log(Math.max(hz, lowHz) / lowHz) / ratio,
        };
    }
    if (scale === "mel") {
        const melHigh = hzToMel(highHz);
        return {
            lowHz: 0,
            highHz,
            frequencyAt: (fraction) => melToHz(fraction * melHigh),
            fractionOf: (hz) => hzToMel(hz) / melHigh,
        };
    }
    return {
        lowHz: 0,
        highHz,
        frequencyAt: (fraction) => fraction * highHz,
        fractionOf: (hz) => hz / highHz,
    };
}

export interface SpectrogramOptions {
    /** First pixel column to compute, relative to the full timeline (device pixels). */
    x0: number;
    /** Number of pixel columns to compute. */
    width: number;
    /** Width of the full timeline in pixels (all samples map onto this). */
    totalWidth: number;
    height: number;
    fftSize: number;
    /** Span in dB covered by the colour scale. */
    dynamicRange: number;
    sampleRate: number;
    scale: FrequencyScale;
    /** Bottom of the logarithmic axis in Hz (linear and mel axes start at 0). */
    minFrequency: number;
    /** Top of the axis in Hz; clamped to the Nyquist frequency. */
    maxFrequency: number;
    /** Boosts the signal before colour mapping (brighter), like Audacity's spectrogram gain. */
    gain: number;
}

const twiddleCache = new Map<number, { cos: Float32Array; sin: Float32Array; reverse: Uint32Array }>();
const windowCache = new Map<number, Float32Array>();

function getTables(size: number) {
    let tables = twiddleCache.get(size);
    if (tables) return tables;
    const half = size / 2;
    const cos = new Float32Array(half);
    const sin = new Float32Array(half);
    for (let i = 0; i < half; i++) {
        cos[i] = Math.cos((2 * Math.PI * i) / size);
        sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    const bits = Math.log2(size);
    const reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        reverse[i] = r;
    }
    tables = { cos, sin, reverse };
    twiddleCache.set(size, tables);
    return tables;
}

export function hannWindow(size: number): Float32Array {
    let window = windowCache.get(size);
    if (window) return window;
    window = new Float32Array(size);
    for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    windowCache.set(size, window);
    return window;
}

/** In-place iterative radix-2 complex FFT. `re.length` must be a power of two. */
export function fft(re: Float32Array, im: Float32Array): void {
    const size = re.length;
    const { cos, sin, reverse } = getTables(size);
    for (let i = 0; i < size; i++) {
        const j = reverse[i];
        if (j > i) {
            const tr = re[i]; re[i] = re[j]; re[j] = tr;
            const ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }
    for (let len = 2; len <= size; len <<= 1) {
        const halfLen = len >> 1;
        const step = size / len;
        for (let start = 0; start < size; start += len) {
            for (let k = 0; k < halfLen; k++) {
                const wr = cos[k * step];
                const wi = sin[k * step];
                const a = start + k;
                const b = a + halfLen;
                const xr = re[b] * wr - im[b] * wi;
                const xi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
            }
        }
    }
}

/**
 * Magnitude spectrum in dB of the `size` samples centred on `center`
 * (zero-padded outside the data). A full-scale sine reads about 0 dB.
 *
 * The input is real, so it is packed into a `size / 2` point complex FFT
 * (even samples -> real part, odd -> imaginary) and unpacked afterwards,
 * which halves the work. `re` and `im` are scratch buffers of `size / 2`.
 * Writes `size / 2` values into `out`, floored at `-dynamicRange`.
 */
export function computeColumn(
    data: Float32Array,
    center: number,
    size: number,
    re: Float32Array,
    im: Float32Array,
    out: Float32Array,
    dynamicRange: number,
): void {
    const half = size / 2;
    const window = hannWindow(size);
    const start = Math.round(center) - half;
    const length = data.length;
    for (let n = 0; n < half; n++) {
        const index = start + 2 * n;
        re[n] = index >= 0 && index < length ? data[index] * window[2 * n] : 0;
        im[n] = index + 1 >= 0 && index + 1 < length ? data[index + 1] * window[2 * n + 1] : 0;
    }
    fft(re, im);

    const { cos, sin } = getTables(size);
    const scale = 4 / size; // Hann coherent gain is 0.5, and the spectrum is one-sided
    const floor = -dynamicRange;
    for (let k = 0; k < half; k++) {
        const mirror = k === 0 ? 0 : half - k;
        const zr = re[k];
        const zi = im[k];
        const cr = re[mirror];
        const ci = -im[mirror];
        const evenR = (zr + cr) * 0.5;
        const evenI = (zi + ci) * 0.5;
        const diffR = (zr - cr) * 0.5;
        const diffI = (zi - ci) * 0.5;
        // odd = diff / i
        const oddR = diffI;
        const oddI = -diffR;
        const wr = cos[k];
        const wi = sin[k];
        const xr = evenR + wr * oddR - wi * oddI;
        const xi = evenI + wr * oddI + wi * oddR;
        const magnitude = Math.sqrt(xr * xr + xi * xi) * scale;
        const db = magnitude > 0 ? 20 * Math.log10(magnitude) : floor;
        out[k] = db < floor ? floor : db;
    }
}

// Dark blue -> violet -> red -> orange -> yellow -> white, in the style of Audacity's default scheme.
const COLOR_STOPS = ["#02010f", "#0d0a45", "#3a0f86", "#8a1fa6", "#d42f6a", "#f9791e", "#fdc92b", "#fff5a0", "#ffffff"];

// <1 lifts the mid-levels so weak-but-audible content is not buried in the dark end.
const LEVEL_GAMMA = 0.8;

function buildLut(stops: string[]): Uint8Array {
    const colors = stops.map((hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)));
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
        const position = (i / 255) * (colors.length - 1);
        const lower = Math.min(colors.length - 2, Math.floor(position));
        const fraction = position - lower;
        for (let c = 0; c < 3; c++) {
            lut[i * 3 + c] = Math.round(colors[lower][c] + (colors[lower + 1][c] - colors[lower][c]) * fraction);
        }
    }
    return lut;
}

const colorLut = buildLut(COLOR_STOPS);

/**
 * Renders one channel's spectrogram into RGBA pixels (lowest frequency at the
 * bottom, Nyquist at the top), on a linear or logarithmic frequency axis.
 *
 * To avoid aliasing:
 * - when a pixel row spans several FFT bins, it shows their maximum;
 * - when a pixel column spans much more audio than one hop, it shows the
 *   maximum over a few frames spread across that span.
 */
export function computeSpectrogramPixels(data: Float32Array, options: SpectrogramOptions): Uint8ClampedArray {
    const { x0, width, totalWidth, height, fftSize, dynamicRange, gain, sampleRate, scale, minFrequency, maxFrequency } = options;
    const pixels = new Uint8ClampedArray(Math.max(0, width) * Math.max(0, height) * 4);
    if (width <= 0 || height <= 0 || totalWidth <= 0) return pixels;

    const bins = fftSize / 2;
    const hop = fftSize / 8;
    const samplesPerPixel = data.length / totalWidth;
    const subFrames = samplesPerPixel > hop * 1.5 ? Math.min(4, Math.round(samplesPerPixel / hop)) : 1;
    const re = new Float32Array(bins);
    const im = new Float32Array(bins);
    const spectrum = new Float32Array(bins);
    const column = new Float32Array(bins);
    // Frames are computed on a fixed grid and blended linearly between
    // neighbours, so zoomed-in views stay smooth instead of showing blocks.
    const frames = new Map<number, Float32Array>();
    const getFrame = (index: number): Float32Array => {
        let frame = frames.get(index);
        if (!frame) {
            frame = new Float32Array(bins);
            computeColumn(data, index * hop, fftSize, re, im, frame, dynamicRange + gain);
            frames.set(index, frame);
        }
        return frame;
    };
    // Gain amplifies the signal before mapping, so the visible window is [-(range + gain), -gain] dBFS.
    const floorDb = -(dynamicRange + gain);

    // Per row: either the inclusive bin range to take the max of, or two bins to interpolate.
    // Bin k sits at k * (sampleRate / fftSize) Hz, so a frequency maps to bin f / df.
    const df = sampleRate / fftSize;
    const axis = createFrequencyAxis(sampleRate, scale, minFrequency, maxFrequency);
    const binAt = (fraction: number): number => axis.frequencyAt(fraction) / df;

    const rowLow = new Int32Array(height);
    const rowHigh = new Int32Array(height);
    const rowFraction = new Float32Array(height);
    for (let y = 0; y < height; y++) {
        const bottomBin = binAt(1 - (y + 1) / height);
        const topBin = binAt(1 - y / height);
        if (topBin - bottomBin >= 1) {
            rowLow[y] = Math.max(0, Math.min(bins - 1, Math.floor(bottomBin + 0.5)));
            rowHigh[y] = Math.max(rowLow[y], Math.min(bins - 1, Math.floor(topBin + 0.5)));
            rowFraction[y] = -1;
        } else {
            const position = Math.max(0, Math.min(bins - 1, (bottomBin + topBin) / 2));
            rowLow[y] = Math.floor(position);
            rowHigh[y] = Math.min(bins - 1, rowLow[y] + 1);
            rowFraction[y] = position - rowLow[y];
        }
    }

    for (let x = 0; x < width; x++) {
        const center = (x0 + x + 0.5) * samplesPerPixel;
        if (subFrames === 1) {
            const position = center / hop;
            const index = Math.floor(position);
            const blend = position - index;
            const first = getFrame(index);
            const second = getFrame(index + 1);
            for (let k = 0; k < bins; k++) column[k] = first[k] + (second[k] - first[k]) * blend;
            for (const key of frames.keys()) if (key < index) frames.delete(key);
        } else {
            column.fill(floorDb);
            for (let s = 0; s < subFrames; s++) {
                const subCenter = center + ((s + 0.5) / subFrames - 0.5) * samplesPerPixel;
                computeColumn(data, subCenter, fftSize, re, im, spectrum, dynamicRange + gain);
                for (let k = 0; k < bins; k++) if (spectrum[k] > column[k]) column[k] = spectrum[k];
            }
        }

        for (let y = 0; y < height; y++) {
            const low = rowLow[y];
            const fraction = rowFraction[y];
            let db: number;
            if (fraction < 0) {
                db = column[low];
                for (let k = low + 1; k <= rowHigh[y]; k++) if (column[k] > db) db = column[k];
            } else {
                db = column[low] + (column[rowHigh[y]] - column[low]) * fraction;
            }
            const normalized = Math.max(0, Math.min(1, (db - floorDb) / dynamicRange));
            const level = Math.round(Math.pow(normalized, LEVEL_GAMMA) * 255);
            const offset = (y * width + x) * 4;
            pixels[offset] = colorLut[level * 3];
            pixels[offset + 1] = colorLut[level * 3 + 1];
            pixels[offset + 2] = colorLut[level * 3 + 2];
            pixels[offset + 3] = 255;
        }
    }
    return pixels;
}

export interface FrequencyTick {
    hz: number;
    /** Distance from the top of the channel, in percent. */
    top: number;
}

const TICK_CANDIDATES = [100, 200, 500, 1000, 2000, 3000, 4000, 6000, 8000, 10000, 12000, 16000, 20000];

/**
 * Axis labels for one channel of `height` px. Uses the same frequency mapping
 * as `computeSpectrogramPixels`, and drops labels that would be closer than
 * `minSpacing` px to a neighbour or to the top/bottom edge labels.
 */
export function getFrequencyTicks(
    sampleRate: number,
    scale: FrequencyScale,
    height: number,
    minFrequency: number,
    maxFrequency: number,
    minSpacing = 16,
): FrequencyTick[] {
    const axis = createFrequencyAxis(sampleRate, scale, minFrequency, maxFrequency);
    const pixels = (percent: number) => (percent / 100) * height;
    const ticks: FrequencyTick[] = [{ hz: axis.highHz, top: 0 }];
    let lastTop = 0;
    for (const hz of TICK_CANDIDATES.filter((value) => value > axis.lowHz && value < axis.highHz).reverse()) {
        const top = (1 - axis.fractionOf(hz)) * 100;
        if (pixels(top - lastTop) >= minSpacing && pixels(100 - top) >= minSpacing) {
            ticks.push({ hz, top });
            lastTop = top;
        }
    }
    ticks.push({ hz: axis.lowHz, top: 100 });
    return ticks;
}
