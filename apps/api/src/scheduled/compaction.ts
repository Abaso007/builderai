import { ConsoleLogger } from "@unprice/logging"
import type { Env } from "~/env"
import {
  type LakehouseSource,
  getDaysAgoUTC,
  getLakehouseCompactedKey,
  getLakehouseLegacyRawPrefix,
  getLakehouseRawPrefix,
} from "~/util/lakehouse"

const COMPACTION_DELAY_DAYS = 1
const SOURCES: LakehouseSource[] = ["usage", "verification", "metadata"]
const R2_BATCH_DELETE_LIMIT = 1000

async function listAllObjects(
  bucket: R2Bucket,
  prefix: string
): Promise<{ key: string; size: number }[]> {
  const objects: { key: string; size: number }[] = []
  let cursor: string | undefined = undefined

  do {
    const res = await bucket.list({ prefix, cursor })
    for (const obj of res.objects) {
      objects.push({ key: obj.key, size: obj.size })
    }
    cursor = res.truncated ? res.cursor : undefined
  } while (cursor)

  return objects
}

async function compactFiles(
  bucket: R2Bucket,
  sourceKeys: string[],
  targetKey: string
): Promise<{ count: number; bytes: number; written: boolean }> {
  if (sourceKeys.length === 0) {
    return { count: 0, bytes: 0, written: false }
  }

  const chunks: Uint8Array[] = []
  let lineCount = 0

  for (const key of sourceKeys) {
    const obj = await bucket.get(key)
    if (!obj?.body) continue

    const reader = obj.body.getReader()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const text = new TextDecoder().decode(value)
      buffer += text

      const lines = buffer.split("\n")
      buffer = lines.pop() || ""
      lineCount += lines.filter((l) => l.trim()).length

      chunks.push(value)
    }

    if (buffer.trim()) {
      lineCount++
    }
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }

  const putResult = await bucket.put(targetKey, result, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/x-ndjson",
    },
    customMetadata: {
      compactedAt: new Date().toISOString(),
      sourceFileCount: sourceKeys.length.toString(),
      lineCount: lineCount.toString(),
    },
  })

  return { count: lineCount, bytes: totalLength, written: putResult !== null }
}

async function deleteSourceFiles(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += R2_BATCH_DELETE_LIMIT) {
    const batch = keys.slice(i, i + R2_BATCH_DELETE_LIMIT)
    await bucket.delete(batch)
  }
}

async function compactDaySource(
  bucket: R2Bucket,
  projectId: string,
  source: LakehouseSource,
  day: string,
  shouldDeleteSourceFiles: boolean
): Promise<{ compacted: boolean; skipped: boolean; files: number; lines: number; bytes: number }> {
  const prefix = getLakehouseRawPrefix(projectId, source, day)
  const legacyPrefix = getLakehouseLegacyRawPrefix(projectId, source, day)
  const [objects, legacyObjects] = await Promise.all([
    listAllObjects(bucket, prefix),
    listAllObjects(bucket, legacyPrefix),
  ])
  const allObjects = [...objects, ...legacyObjects]

  if (allObjects.length === 0) {
    return { compacted: false, skipped: false, files: 0, lines: 0, bytes: 0 }
  }

  allObjects.sort((a, b) => a.key.localeCompare(b.key))

  const sourceKeys = allObjects.map((o) => o.key)
  const targetKey = getLakehouseCompactedKey(projectId, source, day)

  const { count, bytes, written } = await compactFiles(bucket, sourceKeys, targetKey)

  if (!written) {
    return { compacted: false, skipped: true, files: 0, lines: 0, bytes: 0 }
  }

  if (shouldDeleteSourceFiles && count > 0) {
    await deleteSourceFiles(bucket, sourceKeys)
  }

  return { compacted: true, skipped: false, files: sourceKeys.length, lines: count, bytes }
}

async function getAllProjectIds(bucket: R2Bucket): Promise<string[]> {
  const projectIds = new Set<string>()

  const res = await bucket.list({ prefix: "lakehouse/", delimiter: "/" })

  for (const prefix of res.delimitedPrefixes) {
    const parts = prefix.split("/")
    if (parts.length >= 2 && parts[1]) {
      projectIds.add(parts[1])
    }
  }

  return Array.from(projectIds)
}

export interface CompactionResult {
  success: boolean
  day: string
  projectsProcessed: number
  results: Array<{
    projectId: string
    source: LakehouseSource
    compacted: boolean
    skipped: boolean
    files: number
    lines: number
    bytes: number
  }>
  error?: string
}

export async function handleCompactionForDay(
  env: Env,
  day: string,
  deleteSourceFiles = false
): Promise<CompactionResult> {
  const bucket = env.LAKEHOUSE

  if (!bucket) {
    return {
      success: false,
      day,
      projectsProcessed: 0,
      results: [],
      error: "Lakehouse bucket not configured",
    }
  }

  const results: CompactionResult["results"] = []

  try {
    const projectIds = await getAllProjectIds(bucket)

    for (const projectId of projectIds) {
      for (const source of SOURCES) {
        const result = await compactDaySource(bucket, projectId, source, day, deleteSourceFiles)

        results.push({
          projectId,
          source,
          ...result,
        })
      }
    }

    return {
      success: true,
      day,
      projectsProcessed: projectIds.length,
      results,
    }
  } catch (error) {
    return {
      success: false,
      day,
      projectsProcessed: 0,
      results,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

export async function handleCompaction(env: Env): Promise<CompactionResult> {
  const day = getDaysAgoUTC(COMPACTION_DELAY_DAYS)
  return handleCompactionForDay(env, day, true)
}

export async function scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
  const logger = new ConsoleLogger({
    requestId: `compaction-${Date.now()}`,
    environment: env.NODE_ENV,
    service: "api-compaction",
  })

  const result = await handleCompaction(env)

  if (result.success) {
    logger.info("Compaction completed", {
      day: result.day,
      projectsProcessed: result.projectsProcessed,
      filesCompacted: result.results.length,
    })
  } else {
    logger.error("Compaction failed", {
      day: result.day,
      error: result.error,
    })
  }

  return result
}
