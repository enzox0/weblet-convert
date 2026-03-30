import { readFile } from "node:fs/promises"
import { mkdtemp, rm, writeFile as writeFileFs } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execa } from "execa"
import ffmpegPath from "ffmpeg-static"
import { fileTypeFromBuffer } from "file-type"
import sharp from "sharp"

import type { ConvertResult } from "../shared/types.js"

export type ImageToWebpInput = Buffer | Uint8Array | ArrayBuffer | string

export type ImageToWebpOptions = {
  /**
   * Hard cap for output dimensions, preserving aspect ratio.
   * If the input is larger, it will be downscaled.
   */
  maxWidth?: number
  maxHeight?: number

  /**
   * Target maximum output size in bytes.
   * If provided, the encoder will try to reach <= targetBytes by reducing quality.
   */
  targetBytes?: number

  /**
   * Quality search range (0..1). Higher is better quality, larger file.
   */
  maxQuality?: number
  minQuality?: number

  /**
   * If true, always return WebP even if it can't reach targetBytes.
   * If false, will return the original input when WebP isn't supported.
   */
  force?: boolean

  /**
   * Optional output filename (only used when returning a File).
   */
  fileName?: string

  /**
   * Return a File instead of a Blob (only if global File exists).
   */
  returnFile?: boolean
}

export type ImageToWebpResult = {
  blob: Blob
  file?: File
  width: number
  height: number
  quality: number
  /**
   * True if output is `image/webp`.
   */
  isWebp: boolean
}

const DEFAULTS: Required<
  Pick<
    ImageToWebpOptions,
    "maxWidth" | "maxHeight" | "maxQuality" | "minQuality" | "force" | "returnFile"
  >
> = {
  maxWidth: 2048,
  maxHeight: 2048,
  maxQuality: 0.82,
  minQuality: 0.45,
  force: true,
  returnFile: false,
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function quality01ToSharpQ(q: number): number {
  return Math.max(1, Math.min(100, Math.round(clamp01(q) * 100)))
}

function toUint8Array(input: Exclude<ImageToWebpInput, string>): Uint8Array {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) return new Uint8Array(input)
  if (input instanceof Uint8Array) return input
  return new Uint8Array(input)
}

async function inputToBytes(input: ImageToWebpInput): Promise<Uint8Array> {
  if (typeof input !== "string") return toUint8Array(input)

  if (/^https?:\/\//i.test(input)) {
    const res = await fetch(input)
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`)
    const ab = await res.arrayBuffer()
    return new Uint8Array(ab)
  }

  const buf = await readFile(input)
  return new Uint8Array(buf)
}

function makeBlob(bytes: Uint8Array, type: string): Blob {
  if (typeof Blob !== "function") {
    throw new Error("Global Blob is not available (requires Node.js 18+).")
  }
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy], { type })
}

function maybeMakeFile(bytes: Uint8Array, name: string, type: string): File | undefined {
  if (typeof File !== "function") return undefined
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new File([copy], name, { type })
}

function defaultFileName(fileName?: string) {
  return fileName && fileName.trim().length > 0 ? fileName : "image.webp"
}

function defaultVideoFileName(fileName?: string) {
  return fileName && fileName.trim().length > 0 ? fileName : "video.webm"
}

function computeTargetSize(
  srcW: number,
  srcH: number,
  maxW: number,
  maxH: number
): { width: number; height: number } {
  if (srcW <= 0 || srcH <= 0) return { width: srcW, height: srcH }
  const scale = Math.min(1, maxW / srcW, maxH / srcH)
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  }
}

async function encodeWithSharpWebp(
  inputBytes: Uint8Array,
  width: number,
  height: number,
  quality01: number
): Promise<Uint8Array> {
  const q = quality01ToSharpQ(quality01)
  const out = await sharp(inputBytes)
    .resize({
      width,
      height,
      fit: "fill",
      withoutEnlargement: true,
    })
    .webp({ quality: q })
    .toBuffer()
  return new Uint8Array(out)
}

/**
 * Node implementation (sharp) of image->WebP conversion.
 */
export async function imageToWebp(
  input: ImageToWebpInput,
  options: ImageToWebpOptions = {}
): Promise<ImageToWebpResult> {
  const opts = { ...DEFAULTS, ...options }
  const bytes = await inputToBytes(input)

  const meta = await sharp(bytes).metadata()
  const srcW = meta.width ?? 0
  const srcH = meta.height ?? 0
  const { width, height } = computeTargetSize(srcW, srcH, opts.maxWidth, opts.maxHeight)

  const type = "image/webp"

  if (!opts.targetBytes || opts.targetBytes <= 0) {
    const outBytes = await encodeWithSharpWebp(bytes, width, height, opts.maxQuality)
    const blob = makeBlob(outBytes, type)
    const file = opts.returnFile ? maybeMakeFile(outBytes, defaultFileName(opts.fileName), type) : undefined
    return { blob, file, width, height, quality: clamp01(opts.maxQuality), isWebp: true }
  }

  const maxQ = clamp01(opts.maxQuality)
  const minQ = clamp01(Math.min(opts.minQuality, maxQ))

  const atMaxBytes = await encodeWithSharpWebp(bytes, width, height, maxQ)
  if (atMaxBytes.byteLength <= opts.targetBytes) {
    const blob = makeBlob(atMaxBytes, type)
    const file = opts.returnFile ? maybeMakeFile(atMaxBytes, defaultFileName(opts.fileName), type) : undefined
    return { blob, file, width, height, quality: maxQ, isWebp: true }
  }

  const atMinBytes = await encodeWithSharpWebp(bytes, width, height, minQ)
  if (atMinBytes.byteLength > opts.targetBytes) {
    const blob = makeBlob(atMinBytes, type)
    const file = opts.returnFile ? maybeMakeFile(atMinBytes, defaultFileName(opts.fileName), type) : undefined
    return { blob, file, width, height, quality: minQ, isWebp: true }
  }

  let lo = minQ
  let hi = maxQ
  let bestBytes: Uint8Array = atMinBytes
  let bestQ = minQ

  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2
    const enc = await encodeWithSharpWebp(bytes, width, height, mid)
    if (enc.byteLength <= opts.targetBytes) {
      bestBytes = enc
      bestQ = mid
      lo = mid
    } else {
      hi = mid
    }
  }

  const blob = makeBlob(bestBytes, type)
  const file = opts.returnFile ? maybeMakeFile(bestBytes, defaultFileName(opts.fileName), type) : undefined
  return { blob, file, width, height, quality: bestQ, isWebp: true }
}

export type VideoToWebmInput = Buffer | Uint8Array | ArrayBuffer | string

export type VideoToWebmOptions = {
  /**
   * Constant Rate Factor for VP9 (lower is higher quality).
   * Typical range: 18..40. Default 32.
   */
  crf?: number
  /**
   * VP9 deadline/preset: "good" is a reasonable default.
   */
  deadline?: "good" | "best" | "realtime"
  /**
   * Best-effort guardrail to bound work: stops after N seconds.
   */
  maxDurationSeconds?: number

  fileName?: string
  returnFile?: boolean
}

export type VideoToWebmResult = {
  blob: Blob
  file?: File
  /**
   * True if output is `video/webm`.
   */
  isWebm: boolean
}

const VIDEO_DEFAULTS: Required<Pick<VideoToWebmOptions, "crf" | "deadline" | "returnFile">> = {
  crf: 32,
  deadline: "good",
  returnFile: false,
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "weblet-convert-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function getFfmpegPath(): string {
  if (!ffmpegPath) {
    throw new Error(
      "ffmpeg binary not found (ffmpeg-static did not resolve a path). Install optional platform dependencies or provide a runtime where ffmpeg-static can resolve."
    )
  }
  return ffmpegPath
}

function formatArgs(args: string[]): string {
  return args.map((v) => (/\s/.test(v) ? `"${v}"` : v)).join(" ")
}

function getExecErrorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function getLikelyMissingVp9Encoder(errText: string): boolean {
  const lower = errText.toLowerCase()
  return lower.includes("unknown encoder") || lower.includes("libvpx-vp9") || lower.includes("error initializing output stream")
}

function buildVideoArgs(
  inPath: string,
  outPath: string,
  opts: Required<Pick<VideoToWebmOptions, "crf" | "deadline" | "returnFile">> & Pick<VideoToWebmOptions, "maxDurationSeconds">,
  codec: "vp9" | "vp8"
): string[] {
  const args: string[] = [
    "-hide_banner",
    "-y",
    ...(opts.maxDurationSeconds && opts.maxDurationSeconds > 0
      ? ["-t", String(opts.maxDurationSeconds)]
      : []),
    "-i",
    inPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    codec === "vp9" ? "libvpx-vp9" : "libvpx",
    "-b:v",
    "0",
    "-crf",
    String(opts.crf),
    "-deadline",
    opts.deadline,
    ...(codec === "vp9" ? ["-row-mt", "1"] : []),
    "-c:a",
    "libopus",
    outPath,
  ]
  return args
}

/**
 * Node implementation (ffmpeg) of video->WebM conversion.
 */
export async function videoToWebm(
  input: VideoToWebmInput,
  options: VideoToWebmOptions = {}
): Promise<VideoToWebmResult> {
  const ffmpeg = getFfmpegPath()
  const opts = { ...VIDEO_DEFAULTS, ...options }
  const bytes = await inputToBytes(input)

  const type = "video/webm"
  return await withTempDir(async (dir) => {
    const inPath = join(dir, "input")
    const outPath = join(dir, "output.webm")
    await writeFileFs(inPath, bytes)

    const vp9Args = buildVideoArgs(inPath, outPath, opts, "vp9")

    try {
      await execa(ffmpeg, vp9Args, { stderr: "pipe", stdout: "pipe" })
    } catch (err) {
      const execError = getExecErrorText(err)
      if (!getLikelyMissingVp9Encoder(execError)) {
        throw new Error(
          [
            "videoToWebm failed with VP9 encode.",
            `ffmpeg=${ffmpeg}`,
            `args=${formatArgs(vp9Args)}`,
            `error=${execError}`,
          ].join("\n")
        )
      }

      const vp8Args = buildVideoArgs(inPath, outPath, opts, "vp8")
      try {
        await execa(ffmpeg, vp8Args, { stderr: "pipe", stdout: "pipe" })
      } catch (fallbackErr) {
        throw new Error(
          [
            "videoToWebm failed with VP9 and VP8 fallback.",
            `ffmpeg=${ffmpeg}`,
            `vp9_args=${formatArgs(vp9Args)}`,
            `vp9_error=${execError}`,
            `vp8_args=${formatArgs(vp8Args)}`,
            `vp8_error=${getExecErrorText(fallbackErr)}`,
          ].join("\n")
        )
      }
    }

    const out = await readFile(outPath)
    const outBytes = new Uint8Array(out)
    const blob = makeBlob(outBytes, type)
    const file = opts.returnFile ? maybeMakeFile(outBytes, defaultVideoFileName(opts.fileName), type) : undefined
    return { blob, file, isWebm: true }
  })
}

export type ConvertInput = ImageToWebpInput

export type ConvertOptions = {
  image?: ImageToWebpOptions
  video?: VideoToWebmOptions
  returnFile?: boolean
  fileName?: string
}

async function detectKindNode(input: ConvertInput): Promise<"image" | "video" | "unknown"> {
  if (typeof input === "string") {
    const lowered = input.toLowerCase()
    if (/\.(png|jpe?g|gif|webp|avif|bmp|tiff?)($|\?)/i.test(lowered)) return "image"
    if (/\.(mp4|mov|m4v|mkv|webm|avi|wmv|flv)($|\?)/i.test(lowered)) return "video"
  }

  const bytes = await inputToBytes(input)
  const ft = await fileTypeFromBuffer(bytes)
  if (!ft) return "unknown"
  if (ft.mime.startsWith("image/")) return "image"
  if (ft.mime.startsWith("video/")) return "video"
  return "unknown"
}

export async function convert(input: ConvertInput, options: ConvertOptions = {}): Promise<ConvertResult> {
  const kind = await detectKindNode(input)
  const returnFile = options.returnFile ?? false

  if (kind === "image") {
    const res = await imageToWebp(input, { ...options.image, returnFile, fileName: options.fileName })
    return { kind: "image", ...res }
  }

  if (kind === "video") {
    const res = await videoToWebm(input, { ...options.video, returnFile, fileName: options.fileName })
    return { kind: "video", ...res }
  }

  throw new Error("Unsupported input type. Expected an image/* or video/* asset.")
}

