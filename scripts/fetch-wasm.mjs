import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const version = '0.7.6';
const baseUrl = `https://github.com/lxp3/avioflow/releases/download/v${version}`;
const wasmDirectory = path.join(root, 'wasm');
const versionFile = path.join(wasmDirectory, '.version');
const expectedWasmSha256 = '3626bfb197b0e14be06070041d8cb7622d71656e4807feea50f0f260aa6b96b8';

async function sha256(filePath) {
    return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

// Local dev builds (e.g. a locally compiled avioflow.wasm with newer
// exports) live in the same wasm/ directory. Re-downloading the published
// release on every build would silently clobber them. Skip the fetch when
// both files are already present; pass FORCE_FETCH_WASM=1 to override
// (used by CI/release packaging to guarantee the published binaries).
if (!process.env.FORCE_FETCH_WASM) {
    const alreadyPresent = await Promise.all(
        ['avioflow.js', 'avioflow.wasm'].map(filename =>
            access(path.join(wasmDirectory, filename)).then(() => true, () => false)
        )
    );
    const installedVersion = await readFile(versionFile, 'utf8').then(value => value.trim(), () => '');
    const installedWasmSha256 = alreadyPresent[1]
        ? await sha256(path.join(wasmDirectory, 'avioflow.wasm'))
        : '';
    if (alreadyPresent.every(Boolean) && installedVersion === version && installedWasmSha256 === expectedWasmSha256) {
        console.log(`Avioflow WASM v${version} already present and verified, skipping download.`);
        process.exit(0);
    }
}

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

const downloadedWasmSha256 = await sha256(path.join(wasmDirectory, 'avioflow.wasm'));
if (downloadedWasmSha256 !== expectedWasmSha256) {
    throw new Error(`SHA-256 mismatch for avioflow.wasm: expected ${expectedWasmSha256}, got ${downloadedWasmSha256}`);
}
await writeFile(versionFile, `${version}\n`);
console.log(`Verified avioflow.wasm SHA-256 and installed v${version}`);
