import { describe, expect, it } from "vitest"
import sharp from "sharp"
import { execa } from "execa"
import ffmpegPath from "ffmpeg-static"
import { convert, imageToWebp, videoToWebm } from "./index"

async function makePng(width: number, height: number) {
  return await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 40, g: 100, b: 200, alpha: 1 },
    },
  })
    .png()
    .toBuffer()
}

describe("imageToWebp (node)", () => {
  it("downscales to maxWidth/maxHeight", async () => {
    const input = await makePng(1200, 800)
    const res = await imageToWebp(input, { maxWidth: 300, maxHeight: 300 })
    expect(res.isWebp).toBe(true)
    expect(res.width).toBe(300)
    expect(res.height).toBe(200)
    expect(res.blob.type).toBe("image/webp")
  })

  it("tries to meet targetBytes by reducing quality", async () => {
    const input = await makePng(1024, 1024)
    const targetBytes = 20_000
    const res = await imageToWebp(input, {
      targetBytes,
      maxQuality: 0.95,
      minQuality: 0.2,
      maxWidth: 1024,
      maxHeight: 1024,
    })
    expect(res.isWebp).toBe(true)
    expect(res.blob.size).toBeLessThanOrEqual(targetBytes)
    expect(res.quality).toBeGreaterThanOrEqual(0.2)
    expect(res.quality).toBeLessThanOrEqual(0.95)
  })
})

describe("videoToWebm / convert (node)", () => {
  it("converts a generated video to webm", async () => {
    if (!ffmpegPath) {
      // If ffmpeg-static can't resolve on this machine, skip.
      return
    }

    // Generate a tiny AVI with built-in codec (no external libs).
    const gen = await execa(
      ffmpegPath,
      [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x64:rate=10",
      "-t",
      "0.6",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "mpeg4",
      "-f",
      "avi",
      "pipe:1",
      ],
      { encoding: "buffer" }
    )

    const inputBytes = new Uint8Array(gen.stdout as any)
    const res = await videoToWebm(inputBytes, { crf: 40, maxDurationSeconds: 1 })
    expect(res.isWebm).toBe(true)
    expect(res.blob.type).toBe("video/webm")
    expect(res.blob.size).toBeGreaterThan(0)
  })

  it("routes video inputs to videoToWebm()", async () => {
    if (!ffmpegPath) return

    const gen = await execa(
      ffmpegPath,
      [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x64:rate=10",
      "-t",
      "0.4",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "mpeg4",
      "-f",
      "avi",
      "pipe:1",
      ],
      { encoding: "buffer" }
    )

    const inputBytes = new Uint8Array(gen.stdout as any)
    const out = await convert(inputBytes, { video: { crf: 45 } })
    expect(out.kind).toBe("video")
    expect(out.blob.type).toBe("video/webm")
    expect(out.blob.size).toBeGreaterThan(0)
  })
})

