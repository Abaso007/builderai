import { Pool, neonConfig } from "@neondatabase/serverless"
import type { Logger } from "drizzle-orm"
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless"
import { withReplicas } from "drizzle-orm/pg-core"
import ws from "ws"
import type { Database } from "."
import * as schema from "./schema"

export type ConnectionDatabaseOptions = {
  env: "development" | "production" | "test" | "preview"
  primaryDatabaseUrl: string
  read1DatabaseUrl?: string
  read2DatabaseUrl?: string
  logger: boolean
  singleton?: boolean
}

class MyLogger implements Logger {
  logQuery(query: string, params?: unknown[]): void {
    console.info("=".repeat(40))
    console.info("\n\x1b[36m[Drizzle]\x1b[0m\n")
    console.info(`Query:\n${query}\n`)

    if (params && params.length > 0) {
      console.info(`Params:\n${JSON.stringify(params, null, 2)}\n`)
    }
    console.info("=".repeat(40))
  }
}

// only for development when using node 20
neonConfig.webSocketConstructor = typeof WebSocket !== "undefined" ? WebSocket : ws

// use singleton pattern to avoid creating multiple connections
let db: Database | null = null

export function createConnection(opts: ConnectionDatabaseOptions): Database {
  // if the db is already created, return it
  if (db && opts.singleton) {
    return db as Database
  }

  // because an error in cloudflare read1DatabaseUrl is equal to  """"
  // we need to parse that and make it a string
  if (
    opts.read1DatabaseUrl === "" ||
    opts.read1DatabaseUrl?.toString() === '""' ||
    opts.read1DatabaseUrl?.toString() === ""
  ) {
    opts.read1DatabaseUrl = undefined
  }
  if (
    opts.read2DatabaseUrl === "" ||
    opts.read2DatabaseUrl?.toString() === '""' ||
    opts.read2DatabaseUrl?.toString() === ""
  ) {
    opts.read2DatabaseUrl = undefined
  }

  if (opts.env === "development") {
    neonConfig.wsProxy = (host) => {
      return `${host}:5433/v1?address=db:5432`
    }

    neonConfig.useSecureWebSocket = false
    neonConfig.pipelineTLS = false
    neonConfig.pipelineConnect = false
  }

  const poolConfig = {
    connectionString: opts.primaryDatabaseUrl,
    connectionTimeoutMillis: 30000,
    keepAlive: true,
    // Add connection retry logic
    maxUses: 7500,
    idleTimeoutMillis: 30000,
    // Increase statement timeout for complex queries
    queryTimeout: 60000,
  }

  const primary = drizzleNeon(
    new Pool(poolConfig).on("error", (err) => {
      console.error("Database error:", err)
    }),
    {
      schema: schema,
      logger: opts.logger ? new MyLogger() : undefined,
    }
  )

  const read1 = drizzleNeon(
    new Pool({
      connectionString: opts.read1DatabaseUrl,
    }),
    {
      schema: schema,
    }
  )

  const read2 = drizzleNeon(
    new Pool({
      connectionString: opts.read2DatabaseUrl,
    }),
    {
      schema: schema,
    }
  )

  db =
    opts.env === "production" && opts.read1DatabaseUrl && opts.read2DatabaseUrl
      ? withReplicas(primary, [read1, read2])
      : withReplicas(primary, [primary])

  return db as Database
}
