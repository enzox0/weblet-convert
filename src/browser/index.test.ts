import { beforeEach, describe, expect, it, vi } from "vitest"

const runtimeState = {
  loadFailuresRemaining: 0,
  execFailuresRemaining: 0,
  writeCalls: 0,
  terminateCalls: 0,
}

class MockFFmpeg {
  async load() {
    if (runtimeState.loadFailuresRemaining > 0) {
      runtimeState.loadFailuresRemaining -= 1
      throw new Error("mock load failure")
    }
  }
  on() {}
  off() {}
  async writeFile() {
    runtimeState.writeCalls += 1
  }
  async exec() {
    if (runtimeState.execFailuresRemaining > 0) {
      runtimeState.execFailuresRemaining -= 1
      throw new Error("RuntimeError: memory access out of bounds")
    }
  }
  async readFile() {
    return new Uint8Array([1, 2, 3, 4])
  }
  async deleteFile() {}
  async terminate() {
    runtimeState.terminateCalls += 1
  }
}

vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: MockFFmpeg,
}))

vi.mock("@ffmpeg/util", () => ({
  fetchFile: vi.fn(async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())),
}))

describe("videoToWebm (browser)", () => {
  beforeEach(() => {
    vi.resetModules()
    runtimeState.loadFailuresRemaining = 0
    runtimeState.execFailuresRemaining = 0
    runtimeState.writeCalls = 0
    runtimeState.terminateCalls = 0
  })

  it("recovers after initial ffmpeg load failure", async () => {
    const mod = await import("./index")
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" })

    runtimeState.loadFailuresRemaining = 1
    const out = await mod.videoToWebm(input)
    expect(out.isWebm).toBe(true)
    expect(out.blob.type).toBe("video/webm")
  })

  it("rejects oversized input before wasm write", async () => {
    const mod = await import("./index")
    const input = new Blob([new Uint8Array(10)], { type: "video/mp4" })

    await expect(mod.videoToWebm(input, { maxInputBytes: 4 })).rejects.toThrow("input too large")
    expect(runtimeState.writeCalls).toBe(0)
  })

  it("reinitializes ffmpeg and retries once on recoverable wasm crash", async () => {
    const mod = await import("./index")
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" })

    runtimeState.execFailuresRemaining = 1
    const out = await mod.videoToWebm(input)
    expect(out.isWebm).toBe(true)
    expect(runtimeState.terminateCalls).toBe(1)
  })
})

