import type { Pool } from "@neondatabase/serverless"
import type { NeonDatabase } from "drizzle-orm/neon-serverless"
import type { PgWithReplicas } from "drizzle-orm/pg-core"
import type * as schema from "./schema"

export * from "drizzle-orm"
export { pgTableProject as tableCreator } from "./utils"

type NeonDB = PgWithReplicas<
  NeonDatabase<typeof schema> & {
    $client: Pool
  }
>
type NeonTransactionDatabase = Parameters<Parameters<NeonDB["transaction"]>[0]>[0]

export type Database = NeonDB | NeonTransactionDatabase

export { createConnection } from "./createConnection"
