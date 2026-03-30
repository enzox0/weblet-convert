import { writeFile } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"

const execaMock = vi.fn(async (_bin: string, args: string[]) => {
  const outPath = args[args.length - 1]
  const usesVp9 = args.includes("libvpx-vp9")
  if (usesVp9) {
    const err = new Error("Unknown encoder 'libvpx-vp9'")
    throw err
  }
  await writeFile(outPath, new Uint8Array([1, 2, 3]))
  return { stdout: "", stderr: "" } as any
})

vi.mock("ffmpeg-static", () => ({
  default: "ffmpeg",
}))

vi.mock("execa", () => ({
  execa: execaMock,
}))

describe("videoToWebm fallback (node)", () => {
  it("falls back to VP8 when VP9 encoder is unavailable", async () => {
    const mod = await import("./index")
    const out = await mod.videoToWebm(new Uint8Array([9, 8, 7]), { crf: 36 })

    expect(out.isWebm).toBe(true)
    expect(out.blob.type).toBe("video/webm")
    expect(execaMock).toHaveBeenCalledTimes(2)

    const firstArgs = execaMock.mock.calls[0][1]
    const secondArgs = execaMock.mock.calls[1][1]
    expect(firstArgs).toContain("libvpx-vp9")
    expect(secondArgs).toContain("libvpx")
  })
})

