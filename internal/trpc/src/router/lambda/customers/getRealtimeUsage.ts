import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { env } from "#env"
import { protectedProjectProcedure } from "#trpc"

const realtimeMetricsSchema = z.object({
  usageCount: z.number(),
  verificationCount: z.number(),
  totalUsage: z.number(),
  allowedCount: z.number(),
  deniedCount: z.number(),
  bucketSizeSeconds: z.number(),
  featureStats: z.array(
    z.object({
      featureSlug: z.string(),
      usageCount: z.number(),
      verificationCount: z.number(),
      totalUsage: z.number(),
    })
  ),
  usageSeries: z.array(
    z.object({
      bucketStart: z.number(),
      usageCount: z.number(),
      totalUsage: z.number(),
    })
  ),
  verificationSeries: z.array(
    z.object({
      bucketStart: z.number(),
      verificationCount: z.number(),
      allowedCount: z.number(),
      deniedCount: z.number(),
    })
  ),
  oldestTimestamp: z.number().nullable(),
  newestTimestamp: z.number().nullable(),
})

export const getRealtimeUsage = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
      windowSeconds: z
        .union([z.literal(300), z.literal(3600), z.literal(86400), z.literal(604800)])
        .optional()
        .default(3600),
    })
  )
  .output(
    z.object({
      metrics: realtimeMetricsSchema,
      source: z.literal("durable_object"),
    })
  )
  .query(async (opts) => {
    const { customerId, windowSeconds } = opts.input
    const { project } = opts.ctx

    const customer = await opts.ctx.db.query.customers.findFirst({
      columns: { id: true },
      where: (table, { and, eq }) => and(eq(table.id, customerId), eq(table.projectId, project.id)),
    })

    if (!customer) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    const baseUrl = env.UNPRICE_API_URL ?? "https://api.unprice.dev"
    const response = await fetch(`${baseUrl}/v1/analytics/realtime`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.UNPRICE_API_KEY}`,
      },
      body: JSON.stringify({
        customer_id: customerId,
        project_id: project.id,
        window_seconds: windowSeconds,
      }),
      cache: "no-store",
    })

    if (!response.ok) {
      const responseText = await response.text()
      opts.ctx.logger.error("Failed to fetch realtime usage", {
        customerId,
        projectId: project.id,
        status: response.status,
        response: responseText,
      })

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch realtime usage",
      })
    }

    const payload = (await response.json()) as unknown
    const parsed = z
      .object({
        metrics: realtimeMetricsSchema,
        source: z.literal("durable_object"),
      })
      .safeParse(payload)

    if (!parsed.success) {
      opts.ctx.logger.error("Invalid realtime usage payload", {
        customerId,
        projectId: project.id,
        issues: parsed.error.issues,
      })

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Invalid realtime usage payload",
      })
    }

    return parsed.data
  })
