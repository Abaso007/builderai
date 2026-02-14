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

export class NoopLakehouseService implements LakehouseService {
  public async flushRaw(params: LakehouseFlushInput): Promise<LakehouseFlushResult> {
    return {
      success: true,
      cursorState: params.cursorState,
    }
  }

  public async getManifestFiles(_params: LakehouseManifestQuery): Promise<LakehouseManifestFile[]> {
    return []
  }

  public async getFileObject(_key: string): Promise<LakehouseFileObject | null> {
    return null
  }

  public async listProjectsForDay(_day: string): Promise<string[]> {
    return []
  }

  public async compactDaySource(
    _params: LakehouseCompactionRequest
  ): Promise<LakehouseCompactionResult> {
    return {
      compacted: false,
      skipped: false,
      files: 0,
      lines: 0,
      bytes: 0,
      invalidLines: 0,
    }
  }
}
