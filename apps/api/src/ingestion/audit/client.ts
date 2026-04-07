import {
  type IngestionAuditClient,
  buildIngestionAuditShardName,
} from "@unprice/services/ingestion"
import type { Env } from "~/env"

export class CloudflareAuditClient implements IngestionAuditClient {
  private readonly appEnv: Env["APP_ENV"]
  private readonly ingestionaudit: Env["ingestionaudit"]

  constructor(env: Pick<Env, "APP_ENV" | "ingestionaudit">) {
    this.appEnv = env.APP_ENV
    this.ingestionaudit = env.ingestionaudit
  }

  public getAuditStub(params: {
    customerId: string
    projectId: string
    shardIndex: number
  }) {
    return this.ingestionaudit.getByName(
      buildIngestionAuditShardName({
        appEnv: this.appEnv,
        projectId: params.projectId,
        customerId: params.customerId,
        shardIndex: params.shardIndex,
      })
    )
  }
}
