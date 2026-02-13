import { type LakehouseSource, getLakehouseIndexKey } from "~/util/lakehouse"

interface LakehouseIndexObject {
  etag?: string
  text(): Promise<string>
}

interface LakehouseIndexBucket {
  get(key: string): Promise<LakehouseIndexObject | null>
  put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: { contentType?: string }
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }
    }
  ): Promise<unknown | null>
}

export interface LakehouseIndexFileEntry {
  key: string
  bytes: number
  etag?: string
  uploadedAt: string
}

export interface LakehouseDaySourceIndex {
  version: 1
  projectId: string
  source: LakehouseSource
  day: string
  updatedAt: string
  raw: LakehouseIndexFileEntry[]
  compact: LakehouseIndexFileEntry | null
}

const MAX_UPDATE_RETRIES = 6

function createEmptyIndex(
  projectId: string,
  source: LakehouseSource,
  day: string
): LakehouseDaySourceIndex {
  return {
    version: 1,
    projectId,
    source,
    day,
    updatedAt: new Date().toISOString(),
    raw: [],
    compact: null,
  }
}

function parseIndexObject(
  text: string,
  projectId: string,
  source: LakehouseSource,
  day: string
): LakehouseDaySourceIndex {
  const parsed = JSON.parse(text) as Partial<LakehouseDaySourceIndex>

  if (!Array.isArray(parsed.raw)) {
    throw new Error("Invalid raw index")
  }

  return {
    version: 1,
    projectId,
    source,
    day,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    raw: parsed.raw
      .filter((entry): entry is LakehouseIndexFileEntry => {
        return (
          !!entry &&
          typeof entry.key === "string" &&
          typeof entry.bytes === "number" &&
          typeof entry.uploadedAt === "string"
        )
      })
      .slice()
      .sort((a, b) => a.key.localeCompare(b.key)),
    compact:
      parsed.compact &&
      typeof parsed.compact.key === "string" &&
      typeof parsed.compact.bytes === "number" &&
      typeof parsed.compact.uploadedAt === "string"
        ? {
            key: parsed.compact.key,
            bytes: parsed.compact.bytes,
            etag: parsed.compact.etag,
            uploadedAt: parsed.compact.uploadedAt,
          }
        : null,
  }
}

export async function readLakehouseIndex(params: {
  bucket: LakehouseIndexBucket
  projectId: string
  source: LakehouseSource
  day: string
}): Promise<LakehouseDaySourceIndex | null> {
  const key = getLakehouseIndexKey(params.projectId, params.source, params.day)
  const object = await params.bucket.get(key)
  if (!object) {
    return null
  }

  try {
    return parseIndexObject(await object.text(), params.projectId, params.source, params.day)
  } catch {
    return null
  }
}

export async function updateLakehouseIndex(params: {
  bucket: LakehouseIndexBucket
  projectId: string
  source: LakehouseSource
  day: string
  mutate: (current: LakehouseDaySourceIndex) => LakehouseDaySourceIndex
}): Promise<boolean> {
  const key = getLakehouseIndexKey(params.projectId, params.source, params.day)

  for (let attempt = 0; attempt < MAX_UPDATE_RETRIES; attempt += 1) {
    const existing = await params.bucket.get(key)
    const etag = existing?.etag

    let current = createEmptyIndex(params.projectId, params.source, params.day)
    if (existing) {
      try {
        current = parseIndexObject(
          await existing.text(),
          params.projectId,
          params.source,
          params.day
        )
      } catch {
        current = createEmptyIndex(params.projectId, params.source, params.day)
      }
    }

    const next = params.mutate(current)
    next.updatedAt = new Date().toISOString()

    const putResult = await params.bucket.put(key, JSON.stringify(next), {
      httpMetadata: {
        contentType: "application/json",
      },
      onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
    })

    if (putResult !== null) {
      return true
    }
  }

  return false
}

export function addRawEntry(
  current: LakehouseDaySourceIndex,
  entry: LakehouseIndexFileEntry
): LakehouseDaySourceIndex {
  const exists = current.raw.find((item) => item.key === entry.key)
  if (exists) {
    return current
  }

  return {
    ...current,
    raw: [...current.raw, entry].sort((a, b) => a.key.localeCompare(b.key)),
  }
}

export function applyCompactionToIndex(params: {
  current: LakehouseDaySourceIndex
  compact: LakehouseIndexFileEntry
  consumedRawKeys: string[]
}): LakehouseDaySourceIndex {
  const consumed = new Set(params.consumedRawKeys)

  return {
    ...params.current,
    compact: params.compact,
    raw: params.current.raw.filter((entry) => !consumed.has(entry.key)),
  }
}
