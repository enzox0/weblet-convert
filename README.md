# @weblet-convert

Convert **images to WebP** and **videos to WebM** in both **browsers** and **Node.js**.

## What this is for

- **Shrink images for the web**: turn PNG/JPEG/etc into WebP, optionally downscale, and (optionally) try to keep output under a byte budget.
- **Transcode videos for the web**: turn common video formats into WebM.
- **One entrypoint for uploads**: call `convert()` and it will detect **image vs video** and convert appropriately.

## Install

```bash
npm i weblet-convert
```

## Quick start

### Browser

```ts
import { convert } from "weblet-convert"

const res = await convert(fileOrBlobOrUrl, { returnFile: true })
console.log(res.kind, res.blob.type, res.blob.size)
```

- **Input types (browser)**: `Blob | File | string`
  - If `string`, it is fetched as a URL.
- **Output**: always includes `blob`. If `returnFile: true` and the environment has `File`, it also includes `file`.
- **Browser video note**: video transcoding uses ffmpeg.wasm, so large videos can be slow and memory-heavy.

### Node.js

```ts
import { convert } from "weblet-convert/node"
import { readFile } from "node:fs/promises"

const bytes = await readFile("input.png")
const res = await convert(bytes)
const outArrayBuffer = await res.blob.arrayBuffer()
console.log(res.kind, res.blob.type, outArrayBuffer.byteLength)
```

- **Input types (node)**: `Buffer | Uint8Array | ArrayBuffer | string`
  - If `string` starts with `http://` or `https://`, it is fetched.
  - Otherwise it is treated as a local file path.
- **Node requirement**: Node.js **18+** (uses global `fetch` / `Blob`).

## API

### `convert(input, options?)`

Converts based on detected asset type:

- Images → WebP (`imageToWebp()`)
- Videos → WebM (`videoToWebm()`)

## Supported formats

### Outputs
- **Images**: WebP (`image/webp`)
- **Videos**: WebM (`video/webm`, VP9 video + Opus audio)

### Inputs (auto-detected)
- **Images (typical)**: `png`, `jpg` / `jpeg`, `gif`, `bmp`, `tif` / `tiff`, `webp`, `avif`, `svg`
- **Videos (typical)**: `mp4`, `mov`, `m4v`, `mkv`, `webm`, `avi`, `wmv`, `flv`

Notes:
- **Detection** prefers MIME (`File.type` / `Blob.type`) and falls back to magic-byte sniffing.
- **Actual decodability depends on the environment**:
  - **Node** image decoding is handled by `sharp` (supports many formats).
  - **Browser** image decoding depends on the browser’s built-in codecs.
  - **Video transcoding** in the browser uses ffmpeg.wasm and can generally read many formats, but performance varies.

### `imageToWebp(input, options?)`

#### Options

- **`maxWidth` / `maxHeight`**: hard cap for output dimensions (keeps aspect ratio). Default `2048`.
- **`targetBytes`**: if set, tries to encode to **\(\le\)** this size by lowering quality (binary search within the range).
- **`maxQuality` / `minQuality`**: quality range, from `0` to `1`. Defaults `0.82` / `0.45`.
- **`returnFile`**: if `true`, also returns `file` when `File` exists. Default `false`.
- **`fileName`**: output file name (only used when returning a `File`).
- **`force`**: when WebP encoding isn’t supported in the browser, controls whether the original input can be returned instead of WebP. (In Node, WebP is always produced because `sharp` encodes it.)

#### Result

- **`blob`**: output `Blob` (normally `type === "image/webp"`).
- **`file?`**: only present when `returnFile: true` *and* `File` exists.
- **`width` / `height`**: output dimensions.
- **`quality`**: selected quality in the `0..1` range.
- **`isWebp`**: whether the output is actually WebP.

### `videoToWebm(input, options?)`

Transcodes videos to WebM.

`video` options now support ffmpeg.wasm asset configuration in browser runtimes:

- `ffmpeg.baseURL` (auto-derives core/wasm/worker URLs)
- or explicit `ffmpeg.coreURL`, `ffmpeg.wasmURL`, `ffmpeg.workerURL`

### `videoToWebmDebug(input, options?, onEvent?)` (Ultimate debug mode)

Browser-only debug helper for diagnosing ffmpeg.wasm failures.

- Returns `{ ok: true, ...result, events, diagnostic }` on success
- Returns `{ ok: false, error, events, diagnostic }` on failure
- Emits stage events like `init`, `transcode`, `retry-reset`, and `done`
- `diagnostic` includes:
  - `cause` (classified root-cause code, e.g. `ffmpeg-init-failed`, `input-too-large`)
  - `stage` (where it failed)
  - `rawError`
  - `recoverable`
  - `hints` (actionable fixes)

Example:

```ts
import { videoToWebmDebug } from "@weblet/convert"

const debug = await videoToWebmDebug(file, { maxInputBytes: 256 * 1024 * 1024 }, (e) => {
  console.log(`[${e.stage}] ${e.message}`, e.detail ?? "")
})

if (!debug.ok) {
  console.error("WebM conversion failed:", debug.error.message)
  console.error("Cause:", debug.diagnostic.cause)
  console.error("Hints:", debug.diagnostic.hints.join(" | "))
}
```

## Notes and limitations

- **Browser WebP support varies**: the browser build relies on Canvas/OffscreenCanvas WebP encoding support. When encoding isn’t available, the function can return the original input and set `isWebp: false`.
- **Metadata**: EXIF/IPTC metadata is not preserved.
- **Not a perfect “max bytes” guarantee**: `targetBytes` is a best-effort search within the provided quality range.
- **Browser video input limit**: by default there is **no input-size limit** (`maxInputBytes: 0`).  
  If you want a safeguard in your app, set `video: { maxInputBytes: ... }` explicitly.

## Troubleshooting video conversion

- **Browser `RuntimeError: memory access out of bounds`**:
  - Reduce source file size/resolution, trim duration, or lower bitrate.
  - Set a stricter `maxDurationSeconds` and/or adjust `maxInputBytes` for your environment.
  - Ensure ffmpeg.wasm assets can load (no CSP/CORS/asset-path issues).
- **Node conversion fails with VP9 encoder errors**:
  - The Node converter tries VP9 first and automatically falls back to VP8 when VP9 encoder support is missing.
  - If both fail, check bundled ffmpeg capabilities and runtime stderr in the thrown error.

## Import paths

- **Browser**: `import { convert, imageToWebp, videoToWebm, videoToWebmDebug } from "@weblet/convert"`
- **Node**: `import { convert, imageToWebp, videoToWebm } from "weblet-convert/node"`

## Build (contributors)

```bash
npm run build
npm run typecheck
npm test
```

## License

MIT. See `LICENSE`.

