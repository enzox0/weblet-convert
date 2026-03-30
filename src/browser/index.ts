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

async function getFfmpeg(): Promise<FFmpeg> {
  if (ffmpegSingleton) return ffmpegSingleton
  if (ffmpegLoadPromise) return ffmpegLoadPromise
  const ff = new FFmpeg()
  ffmpegLoadPromise = (async () => {
    await ff.load()
    ffmpegSingleton = ff
    return ff
  })()
  return ffmpegLoadPromise
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

export type VideoToWebmInput = Blob | File | string

export type VideoToWebmOptions = {
  crf?: number
  deadline?: "good" | "best" | "realtime"
  maxDurationSeconds?: number
  fileName?: string
  returnFile?: boolean
}

export type VideoToWebmResult = {
  blob: Blob
  file?: File
  isWebm: boolean
}

const VIDEO_DEFAULTS: Required<Pick<VideoToWebmOptions, "crf" | "deadline" | "returnFile">> = {
  crf: 32,
  deadline: "good",
  returnFile: false,
}

export async function videoToWebm(
  input: VideoToWebmInput,
  options: VideoToWebmOptions = {}
): Promise<VideoToWebmResult> {
  const opts = { ...VIDEO_DEFAULTS, ...options }
  const blob = await inputToBlob(input)
  const ffmpeg = await getFfmpeg()
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

  const outBlob = new Blob([outBytes], { type: "video/webm" })
  const file = opts.returnFile ? new File([outBlob], defaultVideoName(input, opts.fileName), { type: outBlob.type }) : undefined
  return { blob: outBlob, file, isWebm: true }
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

