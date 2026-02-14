import type { Logger } from "@unprice/logging"
import type {
  LakehouseCompactionRequest,
  LakehouseCompactionResult,
  LakehouseFileObject,
  LakehouseFlushInput,
  LakehouseFlushResult,
  LakehouseManifestFile,
  LakehouseManifestQuery,
  LakehouseService,
} from "./interface"

type IndexedSource = "usage" | "verification" | "metadata" | "entitlement_snapshot"

interface LakehousePipelineSender {
  send(records: unknown[]): Promise<void>
}

export interface LakehousePipelineBinding {
  send(records: unknown[]): Promise<void>
}

export type LakehousePipelineBindingsBySource = {
  usage: LakehousePipelineBinding
  verification: LakehousePipelineBinding
  metadata: LakehousePipelineBinding
  entitlement_snapshot: LakehousePipelineBinding
}

interface R2ObjectLike {
  body: ReadableStream<Uint8Array> | null
  size: number
  etag?: string
  text(): Promise<string>
}

export interface LakehouseObjectBucket {
  get(key: string): Promise<R2ObjectLike | null>
}

class BindingLakehousePipelineSender implements LakehousePipelineSender {
  private readonly binding: LakehousePipelineBinding

  constructor(binding: LakehousePipelineBinding) {
    this.binding = binding
  }

  public async send(records: unknown[]): Promise<void> {
    await this.binding.send(records)
  }
}

function chunkRecords<T>(records: T[], chunkSize: number): T[][] {
  if (records.length === 0) {
    return []
  }

  const chunks: T[][] = []
  for (let i = 0; i < records.length; i += chunkSize) {
    chunks.push(records.slice(i, i + chunkSize))
  }
  return chunks
}

export class R2IcebergLakehouseService implements LakehouseService {
  private readonly bucket: LakehouseObjectBucket
  private readonly sourceSenders: Record<IndexedSource, LakehousePipelineSender>
  private readonly batchSize: number
  private readonly logger: Logger

  constructor(params: {
    logger: Logger
    bucket?: LakehouseObjectBucket
    pipelines: LakehousePipelineBindingsBySource
    batchSize?: number
  }) {
    this.logger = params.logger
    this.bucket = params.bucket ?? {
      get: async () => null,
    }
    this.batchSize = Math.max(1, params.batchSize ?? 500)

    this.sourceSenders = {
      usage: new BindingLakehousePipelineSender(params.pipelines.usage),
      verification: new BindingLakehousePipelineSender(params.pipelines.verification),
      metadata: new BindingLakehousePipelineSender(params.pipelines.metadata),
      entitlement_snapshot: new BindingLakehousePipelineSender(
        params.pipelines.entitlement_snapshot
      ),
    }
  }

  public async flushRaw(params: LakehouseFlushInput): Promise<LakehouseFlushResult> {
    try {
      const newUsageRecords = params.usageRecords.filter((record) => {
        if (!params.cursorState.lastR2UsageId) return true
        return record.id > params.cursorState.lastR2UsageId
      })

      const verificationRecordsByCursor = params.verificationRecords.filter((record) => {
        if (params.cursorState.lastR2VerificationId === null) return true
        return record.event_id > params.cursorState.lastR2VerificationId
      })

      if (
        newUsageRecords.length === 0 &&
        verificationRecordsByCursor.length === 0 &&
        params.metadataRecords.length === 0 &&
        params.entitlementSnapshots.length === 0
      ) {
        return {
          success: true,
          cursorState: params.cursorState,
        }
      }

      const ingestedAt = new Date().toISOString()
      const sourceBatches: Record<IndexedSource, unknown[]> = {
        usage: this.decorateRecords("usage", newUsageRecords, ingestedAt),
        verification: this.decorateRecords("verification", verificationRecordsByCursor, ingestedAt),
        metadata: this.decorateRecords("metadata", params.metadataRecords, ingestedAt),
        entitlement_snapshot: this.decorateRecords(
          "entitlement_snapshot",
          params.entitlementSnapshots,
          ingestedAt
        ),
      }

      await Promise.all(
        (Object.keys(sourceBatches) as IndexedSource[]).map((source) =>
          this.sendInChunks(source, sourceBatches[source])
        )
      )

      const nextUsageId =
        newUsageRecords.length > 0
          ? newUsageRecords.reduce(
              (max, item) => (item.id > max ? item.id : max),
              newUsageRecords[0]!.id
            )
          : params.cursorState.lastR2UsageId

      const nextVerificationId =
        verificationRecordsByCursor.length > 0
          ? verificationRecordsByCursor.reduce(
              (max, item) => Math.max(max, item.event_id),
              verificationRecordsByCursor[0]!.event_id
            )
          : params.cursorState.lastR2VerificationId

      return {
        success: true,
        cursorState: {
          lastR2UsageId: nextUsageId,
          lastR2VerificationId: nextVerificationId,
        },
      }
    } catch (error) {
      this.logger.error("Failed to flush to R2", {
        error: error instanceof Error ? error.message : "unknown",
      })

      return {
        success: false,
        cursorState: params.cursorState,
      }
    }
  }

  public async getManifestFiles(params: LakehouseManifestQuery): Promise<LakehouseManifestFile[]> {
    this.logger.warn("Manifest file listing is not supported in Iceberg pipeline mode", {
      projectId: params.projectId,
      sources: params.sources.join(","),
      days: params.days.length,
      customerId: params.customerId,
    })
    return []
  }

  public async getFileObject(key: string): Promise<LakehouseFileObject | null> {
    const file = await this.bucket.get(key)
    if (!file?.body) {
      return null
    }

    return {
      body: file.body,
      size: file.size,
      etag: file.etag,
      isCompacted: key.startsWith("lakehouse/compacted/"),
    }
  }

  public async listProjectsForDay(day: string): Promise<string[]> {
    this.logger.warn("Project listing by day is not supported in Iceberg pipeline mode", {
      day,
    })
    return []
  }

  public async compactDaySource(
    params: LakehouseCompactionRequest
  ): Promise<LakehouseCompactionResult> {
    this.logger.info("Manual compaction skipped: managed by Iceberg table maintenance", {
      projectId: params.projectId,
      source: params.source,
      day: params.day,
    })

    return {
      compacted: false,
      skipped: true,
      files: 0,
      lines: 0,
      bytes: 0,
      invalidLines: 0,
    }
  }

  private decorateRecords<T extends object>(
    source: IndexedSource,
    records: T[],
    ingestedAt: string
  ): Array<T & { _lakehouse_source: IndexedSource; _lakehouse_ingested_at: string }> {
    if (records.length === 0) {
      return []
    }

    return records.map((record) => ({
      ...record,
      _lakehouse_source: source,
      _lakehouse_ingested_at: ingestedAt,
    }))
  }

  private async sendInChunks(source: IndexedSource, records: unknown[]): Promise<void> {
    if (records.length === 0) {
      return
    }

    const chunks = chunkRecords(records, this.batchSize)
    const sender = this.sourceSenders[source]
    for (const chunk of chunks) {
      await sender.send(chunk)
    }
  }
}

export class R2D1LakehouseService extends R2IcebergLakehouseService {}
