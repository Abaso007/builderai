// TODO: export like this https://github.com/drizzle-team/drizzle-orm/issues/468
import { Pool, neonConfig } from "@neondatabase/serverless"
import { and, eq, getTableColumns, or, sql } from "drizzle-orm"
// import { drizzle as drizzleHttp } from "drizzle-orm/neon-http"
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless"
import { withReplicas } from "drizzle-orm/pg-core"
import ws from "ws"
import { env } from "../env.mjs"
import * as schema from "./schema"

// TODO: need to check if this is needed
// export const http = neon(env.DATABASE_PRIMARY_URL)
// export const dbHttp = drizzleHttp(http)

neonConfig.webSocketConstructor = typeof WebSocket !== "undefined" ? WebSocket : ws

// if we're running locally
if (env.NODE_ENV === "development") {
  // Set the WebSocket proxy to work with the local instance
  neonConfig.wsProxy = (host) => {
    return `${host}:5433/v1?address=db:5432`
  }
  // Disable all authentication and encryption
  neonConfig.useSecureWebSocket = false
  neonConfig.pipelineTLS = false
  neonConfig.pipelineConnect = false
}

export const primary =
  env.NODE_ENV === "production"
    ? drizzleNeon(
        new Pool({
          connectionString: env.DATABASE_PRIMARY_URL,
        }),
        {
          schema: schema,
          logger: env.DRIZZLE_LOG === "true",
        }
      )
    : drizzleNeon(
        new Pool({
          connectionString: env.DATABASE_URL_LOCAL,
        }).on("error", (err) => {
          console.error("Database error:", err)
        }),
        {
          schema: schema,
          logger: env.DRIZZLE_LOG === "true",
        }
      )

export const read1 = drizzleNeon(
  new Pool({
    connectionString: env.DATABASE_READ1_URL,
  }),
  {
    schema: schema,
    logger: env.DRIZZLE_LOG === "true",
  }
)

export const read2 = drizzleNeon(
  new Pool({
    connectionString: env.DATABASE_READ2_URL,
  }),
  {
    schema: schema,
    logger: env.DRIZZLE_LOG === "true",
  }
)

export const db =
  env.NODE_ENV === "production"
    ? withReplicas(primary, [read1, read2])
    : withReplicas(primary, [primary])

// TODO: do we need all data from the tables?
const projectGuardPrepared = db
  .select({
    project: getTableColumns(schema.projects),
    member: {
      ...getTableColumns(schema.users),
      role: schema.members.role,
    },
    workspace: getTableColumns(schema.workspaces),
  })
  .from(schema.projects)
  .limit(1)
  .where(
    and(
      eq(schema.projects.workspaceId, sql.placeholder("workspaceId")),
      eq(schema.users.id, sql.placeholder("userId")),
      or(
        eq(schema.projects.id, sql.placeholder("projectId")),
        eq(schema.projects.slug, sql.placeholder("projectSlug"))
      )
    )
  )
  .innerJoin(schema.workspaces, eq(schema.projects.workspaceId, schema.workspaces.id))
  .innerJoin(schema.members, eq(schema.members.workspaceId, schema.workspaces.id))
  .innerJoin(schema.users, eq(schema.members.userId, schema.users.id))
  .prepare("project_guard_prepared")

const workspaceGuardPrepared = db
  .select({
    member: {
      ...getTableColumns(schema.users),
      role: schema.members.role,
    },
    workspace: getTableColumns(schema.workspaces),
  })
  .from(schema.workspaces)
  .limit(1)
  .where(
    and(
      or(
        eq(schema.workspaces.id, sql.placeholder("workspaceId")),
        eq(schema.workspaces.slug, sql.placeholder("workspaceSlug"))
      ),
      eq(schema.users.id, sql.placeholder("userId"))
    )
  )
  .innerJoin(schema.members, eq(schema.members.workspaceId, schema.workspaces.id))
  .innerJoin(schema.users, eq(schema.members.userId, schema.users.id))
  .prepare("workspace_guard_prepared")

const workspacesByUserPrepared = db.query.users
  .findFirst({
    with: {
      members: {
        columns: {
          role: true,
        },
        with: {
          workspace: {
            columns: {
              id: true,
              slug: true,
              isPersonal: true,
              name: true,
              plan: true,
              enabled: true,
              unPriceCustomerId: true,
            },
          },
        },
      },
    },
    where: (user, operators) => operators.eq(user.id, sql.placeholder("userId")),
  })
  .prepare("workspaces_by_user_prepared")

const apiKeyPrepared = db.query.apikeys
  .findFirst({
    with: {
      project: {
        columns: {
          workspaceId: true,
          id: true,
          enabled: true,
          slug: true,
          defaultCurrency: true,
        },
        with: {
          workspace: {
            columns: {
              enabled: true,
              unPriceCustomerId: true,
              isPersonal: true,
              plan: true,
            },
          },
        },
      },
    },
    columns: {
      id: true,
      projectId: true,
      key: true,
      expiresAt: true,
      revokedAt: true,
    },
    where: (apikey, { and, eq }) => and(eq(apikey.key, sql.placeholder("apikey"))),
  })
  .prepare("apikey_prepared")

export * from "drizzle-orm"
export { pgTableProject as tableCreator } from "./utils"
export type Database = typeof db

export const prepared = {
  workspacesByUserPrepared,
  projectGuardPrepared,
  workspaceGuardPrepared,
  apiKeyPrepared,
}
