import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const version = (await readFile(path.join(root, 'avioflow-engine-version.txt'), 'utf8')).trim();
const baseUrl = `https://github.com/lxp3/avioflow/releases/download/v${version}-wasm`;
const wasmDirectory = path.join(root, 'wasm');

await mkdir(wasmDirectory, { recursive: true });

await Promise.all(['avioflow.js', 'avioflow.wasm'].map(async (filename) => {
    const response = await fetch(`${baseUrl}/${filename}`);
    if (!response.ok) {
        throw new Error(`Failed to download ${filename}: ${response.status} ${response.statusText}`);
    }

    const destination = path.join(wasmDirectory, filename);
    const temporaryDestination = `${destination}.tmp`;
    await writeFile(temporaryDestination, Buffer.from(await response.arrayBuffer()));
    await rm(destination, { force: true });
    await rename(temporaryDestination, destination);
    console.log(`Downloaded ${filename}`);
}));
