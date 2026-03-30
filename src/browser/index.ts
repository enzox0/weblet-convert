import { FFmpeg } from "@ffmpeg/ffmpeg"
import { fetchFile } from "@ffmpeg/util"
import { fileTypeFromBuffer } from "file-type"

import type { ConvertResult } from "../shared/types.js"

export type ImageToWebpInput = Blob | File | string

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
   * If omitted and input is a File, the name is derived from it.
   */
  fileName?: string

  /**
   * Return a File instead of a Blob.
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

function toWebpName(name: string) {
  const base = name.replace(/\.[^/.]+$/, "")
  return `${base || "image"}.webp`
}

function getInputName(input: ImageToWebpInput) {
  if (typeof input === "string") return "image.webp"
  if (input instanceof File && input.name) return toWebpName(input.name)
  return "image.webp"
}

async function inputToBlob(input: ImageToWebpInput): Promise<Blob> {
  if (typeof input === "string") {
    const res = await fetch(input)
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`)
    return await res.blob()
  }
  return input
}

function toWebmName(name: string) {
  const base = name.replace(/\.[^/.]+$/, "")
  return `${base || "video"}.webm`
}

function defaultVideoName(input: Blob | File | string, fileName?: string) {
  if (fileName && fileName.trim().length > 0) return fileName
  if (typeof input === "string") return "video.webm"
  if (input instanceof File && input.name) return toWebmName(input.name)
  return "video.webm"
}

let ffmpegSingleton: FFmpeg | null = null
let ffmpegLoadPromise: Promise<FFmpeg> | null = null
let ffmpegJobQueue: Promise<void> = Promise.resolve()
let ffmpegConfigKey = "{}"

function normalizeBrowserFfmpegLoadOptions(input?: BrowserFfmpegLoadOptions): BrowserFfmpegLoadOptions | undefined {
  if (!input) return undefined
  const baseURL = input.baseURL?.trim()
  const normalize = (v?: string) => v?.trim() || undefined
  const make = (suffix: string) => {
    if (!baseURL) return undefined
    return `${baseURL.replace(/\/+$/, "")}/${suffix}`
  }
  return {
    baseURL,
    coreURL: normalize(input.coreURL) ?? make("ffmpeg-core.js"),
    wasmURL: normalize(input.wasmURL) ?? make("ffmpeg-core.wasm"),
    workerURL: normalize(input.workerURL) ?? make("ffmpeg-core.worker.js"),
  }
}

function getFfmpegConfigKey(input?: BrowserFfmpegLoadOptions): string {
  return JSON.stringify(normalizeBrowserFfmpegLoadOptions(input) ?? {})
}

async function getFfmpeg(loadOptions?: BrowserFfmpegLoadOptions): Promise<FFmpeg> {
  const nextKey = getFfmpegConfigKey(loadOptions)
  if (nextKey !== ffmpegConfigKey) {
    await resetFfmpegRuntime()
    ffmpegConfigKey = nextKey
  }
  if (ffmpegSingleton) return ffmpegSingleton
  if (ffmpegLoadPromise) return ffmpegLoadPromise
  const ff = new FFmpeg()
  const normalized = normalizeBrowserFfmpegLoadOptions(loadOptions)
  const loadParams =
    normalized && (normalized.coreURL || normalized.wasmURL || normalized.workerURL)
      ? {
          ...(normalized.coreURL ? { coreURL: normalized.coreURL } : {}),
          ...(normalized.wasmURL ? { wasmURL: normalized.wasmURL } : {}),
          ...(normalized.workerURL ? { workerURL: normalized.workerURL } : {}),
        }
      : undefined
  ffmpegLoadPromise = (async () => {
    try {
      await ff.load(loadParams as any)
      ffmpegSingleton = ff
      return ff
    } catch (err) {
      ffmpegLoadPromise = null
      const detail = [
        "Failed to initialize ffmpeg.wasm.",
        `error=${toErrorMessage(err)}`,
        "hint=Ensure ffmpeg core/worker assets are reachable by your bundler/runtime and not blocked by CSP/CORS.",
      ].join("\n")
      throw new Error(detail)
    }
  })()
  return ffmpegLoadPromise
}

async function resetFfmpegRuntime(): Promise<void> {
  const current = ffmpegSingleton
  ffmpegSingleton = null
  ffmpegLoadPromise = null
  if (current && typeof (current as any).terminate === "function") {
    try {
      await (current as any).terminate()
    } catch {
      // Best-effort reset only.
    }
  }
}

async function runWithFfmpegLock<T>(job: () => Promise<T>): Promise<T> {
  const previous = ffmpegJobQueue
  let release!: () => void
  ffmpegJobQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await job()
  } finally {
    release()
  }
}

function createFsSafeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function formatArgs(args: string[]): string {
  return args.map((v) => (/\s/.test(v) ? `"${v}"` : v)).join(" ")
}

function isRecoverableWasmError(err: unknown): boolean {
  const msg = toErrorMessage(err).toLowerCase()
  return (
    msg.includes("memory access out of bounds") ||
    msg.includes("runtimeerror") ||
    msg.includes("aborted") ||
    msg.includes("wasm")
  )
}

export type VideoToWebmInput = Blob | File | string

export type BrowserFfmpegLoadOptions = {
  /**
   * Base URL where ffmpeg.wasm assets live.
   * Missing specific URLs are derived from this.
   */
  baseURL?: string
  coreURL?: string
  wasmURL?: string
  workerURL?: string
}

export type VideoToWebmOptions = {
  crf?: number
  deadline?: "good" | "best" | "realtime"
  maxDurationSeconds?: number
  /**
   * Guardrail for browser wasm memory pressure.
   * Throws before transcoding when input exceeds this limit.
   */
  maxInputBytes?: number
  /**
   * On recoverable wasm crashes, retry with lower-memory ffmpeg args.
   */
  enableLowMemoryFallback?: boolean
  /**
   * Max output width used by low-memory fallback.
   */
  fallbackMaxWidth?: number
  /**
   * Optional browser ffmpeg.wasm asset URL configuration.
   */
  ffmpeg?: BrowserFfmpegLoadOptions
  fileName?: string
  returnFile?: boolean
}

export type VideoToWebmResult = {
  blob: Blob
  file?: File
  isWebm: boolean
}

export type VideoToWebmDebugStage =
  | "input"
  | "guardrail"
  | "init"
  | "transcode"
  | "retry-reset"
  | "retry-init"
  | "retry-transcode"
  | "done"

export type VideoToWebmDebugEvent = {
  stage: VideoToWebmDebugStage
  message: string
  detail?: string
}

export type VideoToWebmDebugCause =
  | "none"
  | "input-fetch-failed"
  | "input-too-large"
  | "ffmpeg-init-failed"
  | "ffmpeg-transcode-failed"
  | "ffmpeg-wasm-runtime-crash"
  | "unsupported-input"
  | "unknown"

export type VideoToWebmDiagnostic = {
  cause: VideoToWebmDebugCause
  stage: VideoToWebmDebugStage
  rawError?: string
  recoverable: boolean
  hints: string[]
}

export type VideoToWebmDebugResult =
  | ({ ok: true } & VideoToWebmResult & { events: VideoToWebmDebugEvent[]; diagnostic: VideoToWebmDiagnostic })
  | { ok: false; error: Error; events: VideoToWebmDebugEvent[]; diagnostic: VideoToWebmDiagnostic }

const VIDEO_DEFAULTS: Required<
  Pick<
    VideoToWebmOptions,
    "crf" | "deadline" | "returnFile" | "maxInputBytes" | "enableLowMemoryFallback" | "fallbackMaxWidth"
  >
> = {
  crf: 32,
  deadline: "good",
  returnFile: false,
  maxInputBytes: 0,
  enableLowMemoryFallback: true,
  fallbackMaxWidth: 960,
}

function assertVideoInputGuardrails(blob: Blob, opts: Required<Pick<VideoToWebmOptions, "maxInputBytes">>) {
  if (opts.maxInputBytes > 0 && blob.size > opts.maxInputBytes) {
    throw new Error(
      [
        "videoToWebm guardrail: input too large for browser ffmpeg.wasm.",
        `input_bytes=${blob.size}`,
        `max_input_bytes=${opts.maxInputBytes}`,
        "hint=Lower source resolution/bitrate, trim video, or increase maxInputBytes if your environment has enough memory.",
      ].join("\n")
    )
  }
}

type NormalizedVideoOptions = Required<
  Pick<
    VideoToWebmOptions,
    "crf" | "deadline" | "returnFile" | "maxInputBytes" | "enableLowMemoryFallback" | "fallbackMaxWidth"
  >
> &
  Pick<VideoToWebmOptions, "maxDurationSeconds" | "fileName" | "ffmpeg">

function buildVideoDiagnostic(stage: VideoToWebmDebugStage, err: unknown): VideoToWebmDiagnostic {
  const raw = toErrorMessage(err)
  const lower = raw.toLowerCase()
  const recoverable = isRecoverableWasmError(err)

  if (lower.includes("failed to fetch")) {
    return {
      cause: "input-fetch-failed",
      stage,
      rawError: raw,
      recoverable: false,
      hints: ["Verify URL reachability and CORS policy for browser fetch."],
    }
  }

  if (lower.includes("input too large") || lower.includes("max_input_bytes")) {
    return {
      cause: "input-too-large",
      stage,
      rawError: raw,
      recoverable: false,
      hints: ["Increase maxInputBytes or reduce source size/resolution/duration."],
    }
  }

  if (lower.includes("failed to initialize ffmpeg.wasm")) {
    return {
      cause: "ffmpeg-init-failed",
      stage,
      rawError: raw,
      recoverable,
      hints: [
        "Provide video.ffmpeg.baseURL or explicit coreURL/wasmURL/workerURL.",
        "Ensure CSP/CORS allows ffmpeg worker + wasm assets.",
      ],
    }
  }

  if (lower.includes("memory access out of bounds") || lower.includes("runtimeerror") || lower.includes("aborted")) {
    return {
      cause: "ffmpeg-wasm-runtime-crash",
      stage,
      rawError: raw,
      recoverable: true,
      hints: ["Reduce workload: trim duration, lower resolution/bitrate, or split video."],
    }
  }

  if (lower.includes("videotowebm failed")) {
    return {
      cause: "ffmpeg-transcode-failed",
      stage,
      rawError: raw,
      recoverable,
      hints: ["Inspect ffmpeg_logs in rawError for codec/container-specific details."],
    }
  }

  if (lower.includes("unsupported input type")) {
    return {
      cause: "unsupported-input",
      stage,
      rawError: raw,
      recoverable: false,
      hints: ["Use a valid image/* or video/* input and ensure proper MIME/magic bytes."],
    }
  }

  return {
    cause: "unknown",
    stage,
    rawError: raw,
    recoverable,
    hints: ["Use videoToWebmDebug() output to trace failing stage and share rawError."],
  }
}

async function runVideoTranscodeJob(ffmpeg: FFmpeg, blob: Blob, opts: NormalizedVideoOptions) {
  const jobId = createFsSafeId()
  const inName = `input-${jobId}`
  const outName = `output-${jobId}.webm`

  const outBytes = await runWithFfmpegLock(async () => {
    await ffmpeg.writeFile(inName, await fetchFile(blob))

    const args: string[] = [
      ...(opts.maxDurationSeconds && opts.maxDurationSeconds > 0 ? ["-t", String(opts.maxDurationSeconds)] : []),
      "-i",
      inName,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      String(opts.crf),
      "-deadline",
      opts.deadline,
      "-row-mt",
      "1",
      "-c:a",
      "libopus",
      outName,
    ]

    const logs: string[] = []
    const onLog = ({ message }: { message: string }) => {
      if (typeof message !== "string" || message.length === 0) return
      logs.push(message)
      if (logs.length > 60) logs.shift()
    }

    try {
      ffmpeg.on("log", onLog)
      await ffmpeg.exec(args)
      const outData = await ffmpeg.readFile(outName)
      return outData instanceof Uint8Array ? outData : new Uint8Array(outData as any)
    } catch (err) {
      const detail = [
        `videoToWebm failed.`,
        `input=${inName}`,
        `output=${outName}`,
        `args=${formatArgs(args)}`,
        `error=${toErrorMessage(err)}`,
        logs.length ? `ffmpeg_logs:\n${logs.join("\n")}` : "ffmpeg_logs: <none>",
      ].join("\n")
      throw new Error(detail)
    } finally {
      ffmpeg.off("log", onLog)
      await Promise.allSettled([ffmpeg.deleteFile(inName), ffmpeg.deleteFile(outName)])
    }
  })

  return new Blob([outBytes], { type: "video/webm" })
}

async function runVideoTranscodeLowMemoryJob(ffmpeg: FFmpeg, blob: Blob, opts: NormalizedVideoOptions) {
  const jobId = createFsSafeId()
  const inName = `input-${jobId}`
  const outName = `output-${jobId}.webm`
  const safeWidth = Math.max(320, Math.round(opts.fallbackMaxWidth))

  const outBytes = await runWithFfmpegLock(async () => {
    await ffmpeg.writeFile(inName, await fetchFile(blob))

    const args: string[] = [
      ...(opts.maxDurationSeconds && opts.maxDurationSeconds > 0 ? ["-t", String(opts.maxDurationSeconds)] : []),
      "-i",
      inName,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-vf",
      `scale='min(${safeWidth},iw)':-2:flags=bilinear`,
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      String(Math.max(34, opts.crf)),
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-row-mt",
      "1",
      "-c:a",
      "libopus",
      outName,
    ]

    const logs: string[] = []
    const onLog = ({ message }: { message: string }) => {
      if (typeof message !== "string" || message.length === 0) return
      logs.push(message)
      if (logs.length > 60) logs.shift()
    }

    try {
      ffmpeg.on("log", onLog)
      await ffmpeg.exec(args)
      const outData = await ffmpeg.readFile(outName)
      return outData instanceof Uint8Array ? outData : new Uint8Array(outData as any)
    } catch (err) {
      const detail = [
        `videoToWebm low-memory fallback failed.`,
        `input=${inName}`,
        `output=${outName}`,
        `args=${formatArgs(args)}`,
        `error=${toErrorMessage(err)}`,
        logs.length ? `ffmpeg_logs:\n${logs.join("\n")}` : "ffmpeg_logs: <none>",
      ].join("\n")
      throw new Error(detail)
    } finally {
      ffmpeg.off("log", onLog)
      await Promise.allSettled([ffmpeg.deleteFile(inName), ffmpeg.deleteFile(outName)])
    }
  })

  return new Blob([outBytes], { type: "video/webm" })
}

export async function videoToWebm(
  input: VideoToWebmInput,
  options: VideoToWebmOptions = {}
): Promise<VideoToWebmResult> {
  const opts = { ...VIDEO_DEFAULTS, ...options }
  const blob = await inputToBlob(input)
  assertVideoInputGuardrails(blob, opts)

  let outBlob: Blob
  try {
    const ffmpeg = await getFfmpeg(opts.ffmpeg)
    outBlob = await runVideoTranscodeJob(ffmpeg, blob, opts)
  } catch (err) {
    if (!isRecoverableWasmError(err)) throw err
    await resetFfmpegRuntime()
    const ffmpeg = await getFfmpeg(opts.ffmpeg)
    try {
      outBlob = await runVideoTranscodeJob(ffmpeg, blob, opts)
    } catch (retryErr) {
      if (!isRecoverableWasmError(retryErr) || !opts.enableLowMemoryFallback) throw retryErr
      await resetFfmpegRuntime()
      const ffmpegFallback = await getFfmpeg(opts.ffmpeg)
      outBlob = await runVideoTranscodeLowMemoryJob(ffmpegFallback, blob, opts)
    }
  }

  const file = opts.returnFile ? new File([outBlob], defaultVideoName(input, opts.fileName), { type: outBlob.type }) : undefined
  return { blob: outBlob, file, isWebm: true }
}

export async function videoToWebmDebug(
  input: VideoToWebmInput,
  options: VideoToWebmOptions = {},
  onEvent?: (event: VideoToWebmDebugEvent) => void
): Promise<VideoToWebmDebugResult> {
  const events: VideoToWebmDebugEvent[] = []
  let lastStage: VideoToWebmDebugStage = "input"
  const emit = (event: VideoToWebmDebugEvent) => {
    lastStage = event.stage
    events.push(event)
    onEvent?.(event)
  }

  try {
    emit({ stage: "input", message: "Reading input as Blob." })
    const opts = { ...VIDEO_DEFAULTS, ...options }
    const blob = await inputToBlob(input)

    emit({
      stage: "guardrail",
      message: "Checking browser ffmpeg.wasm memory guardrail.",
      detail: `input_bytes=${blob.size};max_input_bytes=${opts.maxInputBytes}`,
    })
    assertVideoInputGuardrails(blob, opts)

    let outBlob: Blob
    try {
      emit({ stage: "init", message: "Initializing ffmpeg.wasm runtime." })
      const ffmpeg = await getFfmpeg(opts.ffmpeg)
      emit({ stage: "transcode", message: "Running video transcode job (VP9 + Opus)." })
      outBlob = await runVideoTranscodeJob(ffmpeg, blob, opts)
    } catch (err) {
      if (!isRecoverableWasmError(err)) throw err
      emit({
        stage: "retry-reset",
        message: "Recoverable wasm error detected, resetting runtime.",
        detail: toErrorMessage(err),
      })
      await resetFfmpegRuntime()
      emit({ stage: "retry-init", message: "Reinitializing ffmpeg.wasm runtime." })
      const ffmpeg = await getFfmpeg(opts.ffmpeg)
      emit({ stage: "retry-transcode", message: "Retrying video transcode job." })
      try {
        outBlob = await runVideoTranscodeJob(ffmpeg, blob, opts)
      } catch (retryErr) {
        if (!isRecoverableWasmError(retryErr) || !opts.enableLowMemoryFallback) throw retryErr
        emit({
          stage: "retry-transcode",
          message: "Running low-memory fallback transcode profile.",
          detail: `fallback_max_width=${opts.fallbackMaxWidth}`,
        })
        await resetFfmpegRuntime()
        const ffmpegFallback = await getFfmpeg(opts.ffmpeg)
        outBlob = await runVideoTranscodeLowMemoryJob(ffmpegFallback, blob, opts)
      }
    }

    const file = opts.returnFile ? new File([outBlob], defaultVideoName(input, opts.fileName), { type: outBlob.type }) : undefined
    emit({
      stage: "done",
      message: "Video converted to WebM.",
      detail: `output_bytes=${outBlob.size};mime=${outBlob.type}`,
    })
    return {
      ok: true,
      blob: outBlob,
      file,
      isWebm: true,
      events,
      diagnostic: { cause: "none", stage: "done", recoverable: false, hints: [] },
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(toErrorMessage(err))
    const diagnostic = buildVideoDiagnostic(lastStage, error)
    emit({
      stage: "done",
      message: "Video conversion failed.",
      detail: `cause=${diagnostic.cause};${error.message}`,
    })
    return { ok: false, error, events, diagnostic }
  }
}

export type ConvertInput = ImageToWebpInput

export type ConvertOptions = {
  image?: ImageToWebpOptions
  video?: VideoToWebmOptions
  returnFile?: boolean
  fileName?: string
}

async function detectKindBrowser(input: ConvertInput): Promise<"image" | "video" | "unknown"> {
  if (typeof input !== "string") {
    const t = (input.type || "").toLowerCase()
    if (t.startsWith("image/")) return "image"
    if (t.startsWith("video/")) return "video"
  }

  const blob = await inputToBlob(input)
  const buf = new Uint8Array(await blob.slice(0, 4100).arrayBuffer())
  const ft = await fileTypeFromBuffer(buf)
  if (!ft) return "unknown"
  if (ft.mime.startsWith("image/")) return "image"
  if (ft.mime.startsWith("video/")) return "video"
  return "unknown"
}

export async function convert(input: ConvertInput, options: ConvertOptions = {}): Promise<ConvertResult> {
  const kind = await detectKindBrowser(input)
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

async function decodeImage(blob: Blob): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" as any })
    return { bitmap, width: bitmap.width, height: bitmap.height }
  }

  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error("Failed to decode image"))
      el.src = url
    })

    const canvas = document.createElement("canvas")
    canvas.width = img.naturalWidth || img.width
    canvas.height = img.naturalHeight || img.height
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("Canvas 2D context not available")
    ctx.drawImage(img, 0, 0)

    const dataUrl = canvas.toDataURL("image/png")
    const pngBlob = await (await fetch(dataUrl)).blob()
    const bitmap = await createImageBitmap(pngBlob)
    return { bitmap, width: bitmap.width, height: bitmap.height }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function encodeWebpFromBitmap(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number
): Promise<Blob | null> {
  const q = clamp01(quality)

  const hasOffscreen = typeof OffscreenCanvas !== "undefined"
  if (hasOffscreen) {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, width, height)
    try {
      return await canvas.convertToBlob({ type: "image/webp", quality: q })
    } catch {
      return null
    }
  }

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, width, height)

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/webp", q)
  })
  return blob
}

/**
 * Convert an image (png/jpg/etc) to WebP and shrink size while keeping similar quality.
 *
 * - Downscales to `maxWidth`/`maxHeight` (keeps aspect ratio).
 * - Encodes as WebP with a quality search to try meeting `targetBytes` (if provided).
 */
export async function imageToWebp(
  input: ImageToWebpInput,
  options: ImageToWebpOptions = {}
): Promise<ImageToWebpResult> {
  const opts = { ...DEFAULTS, ...options }
  const blob = await inputToBlob(input)

  const { bitmap, width: srcW, height: srcH } = await decodeImage(blob)
  try {
    const { width, height } = computeTargetSize(srcW, srcH, opts.maxWidth, opts.maxHeight)

    if (!opts.targetBytes || opts.targetBytes <= 0) {
      const out = await encodeWebpFromBitmap(bitmap, width, height, opts.maxQuality)
      if (!out) {
        if (!opts.force) return { blob, width: srcW, height: srcH, quality: 1, isWebp: false }
        return { blob, width: srcW, height: srcH, quality: 1, isWebp: false }
      }

      const fileName = opts.fileName ?? getInputName(input)
      const file = opts.returnFile ? new File([out], fileName, { type: out.type }) : undefined
      return { blob: out, file, width, height, quality: opts.maxQuality, isWebp: true }
    }

    const maxQ = clamp01(opts.maxQuality)
    const minQ = clamp01(Math.min(opts.minQuality, maxQ))

    const atMax = await encodeWebpFromBitmap(bitmap, width, height, maxQ)
    if (!atMax) {
      if (!opts.force) return { blob, width: srcW, height: srcH, quality: 1, isWebp: false }
      return { blob, width: srcW, height: srcH, quality: 1, isWebp: false }
    }
    if (atMax.size <= opts.targetBytes) {
      const fileName = opts.fileName ?? getInputName(input)
      const file = opts.returnFile ? new File([atMax], fileName, { type: atMax.type }) : undefined
      return { blob: atMax, file, width, height, quality: maxQ, isWebp: true }
    }

    const atMin = await encodeWebpFromBitmap(bitmap, width, height, minQ)
    if (!atMin) {
      const fileName = opts.fileName ?? getInputName(input)
      const file = opts.returnFile ? new File([atMax], fileName, { type: atMax.type }) : undefined
      return { blob: atMax, file, width, height, quality: maxQ, isWebp: true }
    }
    if (atMin.size > opts.targetBytes) {
      const fileName = opts.fileName ?? getInputName(input)
      const file = opts.returnFile ? new File([atMin], fileName, { type: atMin.type }) : undefined
      return { blob: atMin, file, width, height, quality: minQ, isWebp: true }
    }

    let lo = minQ
    let hi = maxQ
    let bestBlob: Blob = atMin
    let bestQ = minQ

    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2
      const enc = await encodeWebpFromBitmap(bitmap, width, height, mid)
      if (!enc) break

      if (enc.size <= opts.targetBytes) {
        bestBlob = enc
        bestQ = mid
        lo = mid
      } else {
        hi = mid
      }
    }

    const fileName = opts.fileName ?? getInputName(input)
    const file = opts.returnFile ? new File([bestBlob], fileName, { type: bestBlob.type }) : undefined
    return { blob: bestBlob, file, width, height, quality: bestQ, isWebp: true }
  } finally {
    bitmap.close()
  }
}

