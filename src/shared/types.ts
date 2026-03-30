export type ConvertKind = "image" | "video"

export type ConvertResultCommon = {
  kind: ConvertKind
  blob: Blob
  file?: File
}

export type ConvertImageResult = ConvertResultCommon & {
  kind: "image"
  width: number
  height: number
  quality: number
  isWebp: boolean
}

export type ConvertVideoResult = ConvertResultCommon & {
  kind: "video"
  isWebm: boolean
}

export type ConvertResult = ConvertImageResult | ConvertVideoResult

