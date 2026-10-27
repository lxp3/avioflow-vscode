import { computeSpectrogramPixels, type SpectrogramOptions } from "./spectrogram";

type WorkerRequest =
    | { type: "data"; version: number; channels: Float32Array[] }
    | { type: "render"; version: number; channel: number; options: SpectrogramOptions; meta: unknown };

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
    postMessage(message: unknown, transfer: Transferable[]): void;
};

let channels: Float32Array[] = [];

scope.onmessage = (event) => {
    const message = event.data;
    if (message.type === "data") {
        channels = message.channels;
        return;
    }
    const data = channels[message.channel];
    const pixels = data
        ? computeSpectrogramPixels(data, message.options)
        : new Uint8ClampedArray(message.options.width * message.options.height * 4);
    scope.postMessage(
        {
            version: message.version,
            channel: message.channel,
            options: message.options,
            meta: message.meta,
            pixels,
        },
        [pixels.buffer],
    );
};
