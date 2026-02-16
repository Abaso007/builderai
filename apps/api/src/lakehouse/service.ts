import type { Logger } from "@unprice/logging"
import { CloudflarePipelineLakehouseService } from "./pipeline"

interface LakehouseServiceEnv {
  LAKEHOUSE_PIPELINE_USAGE: { send: (records: unknown[]) => Promise<void> }
  LAKEHOUSE_PIPELINE_VERIFICATION: { send: (records: unknown[]) => Promise<void> }
  LAKEHOUSE_PIPELINE_METADATA: { send: (records: unknown[]) => Promise<void> }
  LAKEHOUSE_PIPELINE_ENTITLEMENT_SNAPSHOT: { send: (records: unknown[]) => Promise<void> }
}

export function createCloudflareLakehouseService(params: {
  logger: Logger
  env: LakehouseServiceEnv
}): CloudflarePipelineLakehouseService {
  return new CloudflarePipelineLakehouseService({
    logger: params.logger,
    pipelines: {
      usage: params.env.LAKEHOUSE_PIPELINE_USAGE,
      verification: params.env.LAKEHOUSE_PIPELINE_VERIFICATION,
      metadata: params.env.LAKEHOUSE_PIPELINE_METADATA,
      entitlement_snapshot: params.env.LAKEHOUSE_PIPELINE_ENTITLEMENT_SNAPSHOT,
    },
  })
}
