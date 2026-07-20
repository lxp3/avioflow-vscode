import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const version = (await readFile(path.join(root, 'avioflow-engine-version.txt'), 'utf8')).trim();
const baseUrl = `https://github.com/lxp3/avioflow/releases/download/v${version}-wasm`;
const wasmDirectory = path.join(root, 'wasm');

await mkdir(wasmDirectory, { recursive: true });

async function download(filename) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await fetch(`${baseUrl}/${filename}`);
            if (!response.ok) {
                throw new Error(`${response.status} ${response.statusText}`);
            }

            const destination = path.join(wasmDirectory, filename);
            const temporaryDestination = `${destination}.tmp`;
            await writeFile(temporaryDestination, Buffer.from(await response.arrayBuffer()));
            await rm(destination, { force: true });
            await rename(temporaryDestination, destination);
            console.log(`Downloaded ${filename}`);
            return;
        } catch (error) {
            lastError = error;
            if (attempt < 3) {
                await setTimeout(attempt * 2000);
            }
        }
    }

    throw new Error(`Failed to download ${filename}`, { cause: lastError });
}

for (const filename of ['avioflow.js', 'avioflow.wasm']) {
    await download(filename);
}
