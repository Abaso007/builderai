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

class CompactWriteError extends Error {
  public readonly kind: "invalid" | "empty"

  constructor(kind: "invalid" | "empty", message: string) {
    super(message)
    this.name = "CompactWriteError"
    this.kind = kind
  }
}

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

async function* streamNdjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let carry = ""

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }

      const chunk = decoder.decode(value, { stream: true })

      if (!chunk) {
        continue
      }

      const combined = `${carry}${chunk}`
      const lines = combined.split("\n")
      carry = lines.pop() ?? ""

      for (const line of lines) {
        yield line.endsWith("\r") ? line.slice(0, -1) : line
      }
    }

    const remaining = decoder.decode()
    carry = remaining.length > 0 ? `${carry}${remaining}` : carry

    if (carry) {
      yield carry.endsWith("\r") ? carry.slice(0, -1) : carry
    }
  } finally {
    reader.releaseLock()
  }
}

function createCompactStream(
  bucket: R2Bucket,
  sourceKeys: string[],
  counters: {
    count: number
    invalidLines: number
    bytes: number
  }
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream({
    async start(controller) {
      try {
        let hasInvalidLines = false

        for (const key of sourceKeys) {
          const obj = await bucket.get(key)
          if (!obj?.body) {
            continue
          }

          for await (const line of streamNdjsonLines(obj.body)) {
            const trimmed = line.trim()
            if (!trimmed) {
              continue
            }

            if (hasInvalidLines) {
              try {
                JSON.parse(trimmed)
              } catch {
                counters.invalidLines += 1
              }

              continue
            }

            try {
              JSON.parse(trimmed)
            } catch {
              counters.invalidLines += 1
              hasInvalidLines = true
              continue
            }

            counters.count += 1

            const output = encoder.encode(`${trimmed}\n`)
            counters.bytes += output.byteLength
            controller.enqueue(output)
          }
        }

        if (counters.invalidLines > 0) {
          throw new CompactWriteError("invalid", "NDJSON validation failed")
        }

        if (counters.count === 0) {
          throw new CompactWriteError("empty", "No valid NDJSON records found")
        }

        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

async function compactFiles(
  bucket: R2Bucket,
  sourceKeys: string[],
  targetKey: string
): Promise<{ count: number; bytes: number; written: boolean; invalidLines: number }> {
  if (sourceKeys.length === 0) {
    return { count: 0, bytes: 0, written: false, invalidLines: 0 }
  }

  const counters = {
    count: 0,
    invalidLines: 0,
    bytes: 0,
  }
  const resultStream = createCompactStream(bucket, sourceKeys, counters)

  try {
    const putResult = await bucket.put(targetKey, resultStream, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/x-ndjson",
      },
      customMetadata: {
        compactedAt: new Date().toISOString(),
        sourceFileCount: sourceKeys.length.toString(),
        lineCount: counters.count.toString(),
        invalidLineCount: counters.invalidLines.toString(),
      },
    })

    return {
      count: counters.count,
      bytes: counters.bytes,
      written: putResult !== null,
      invalidLines: counters.invalidLines,
    }
  } catch (error) {
    if (error instanceof CompactWriteError && error.kind === "invalid") {
      return {
        count: counters.count,
        bytes: 0,
        written: false,
        invalidLines: counters.invalidLines,
      }
    }

    if (error instanceof CompactWriteError && error.kind === "empty") {
      return {
        count: 0,
        bytes: 0,
        written: false,
        invalidLines: 0,
      }
    }

    throw error
  }
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
): Promise<{
  compacted: boolean
  skipped: boolean
  files: number
  lines: number
  bytes: number
  invalidLines: number
}> {
  const prefix = getLakehouseRawPrefix(projectId, source, day)
  const legacyPrefix = getLakehouseLegacyRawPrefix(projectId, source, day)
  const [objects, legacyObjects] = await Promise.all([
    listAllObjects(bucket, prefix),
    listAllObjects(bucket, legacyPrefix),
  ])
  const allObjects = [...objects, ...legacyObjects]

  if (allObjects.length === 0) {
    return { compacted: false, skipped: false, files: 0, lines: 0, bytes: 0, invalidLines: 0 }
  }

  allObjects.sort((a, b) => a.key.localeCompare(b.key))

  const sourceKeys = allObjects.map((o) => o.key)
  const targetKey = getLakehouseCompactedKey(projectId, source, day)

  const { count, bytes, written, invalidLines } = await compactFiles(bucket, sourceKeys, targetKey)

  if (!written) {
    return {
      compacted: false,
      skipped: true,
      files: sourceKeys.length,
      lines: 0,
      bytes: 0,
      invalidLines,
    }
  }

  if (shouldDeleteSourceFiles && count > 0) {
    await deleteSourceFiles(bucket, sourceKeys)
  }

  return {
    compacted: true,
    skipped: false,
    files: sourceKeys.length,
    lines: count,
    bytes,
    invalidLines,
  }
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
    invalidLines: number
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
