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

## Notes and limitations

- **Browser WebP support varies**: the browser build relies on Canvas/OffscreenCanvas WebP encoding support. When encoding isn’t available, the function can return the original input and set `isWebp: false`.
- **Metadata**: EXIF/IPTC metadata is not preserved.
- **Not a perfect “max bytes” guarantee**: `targetBytes` is a best-effort search within the provided quality range.

## Import paths

- **Browser**: `import { convert, imageToWebp, videoToWebm } from "@weblet/convert"`
- **Node**: `import { convert, imageToWebp, videoToWebm } from "weblet-convert/node"`

## Build (contributors)

```bash
npm run build
npm run typecheck
npm test
```

## License

MIT. See `LICENSE`.

