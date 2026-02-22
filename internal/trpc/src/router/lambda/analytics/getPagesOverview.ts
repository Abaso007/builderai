import type { Analytics } from "@unprice/analytics"
import type { PageOverview } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getPagesOverview = protectedProjectProcedure
  .input(z.custom<Parameters<Analytics["getPagesOverview"]>[0]>())
  .output(
    z.object({
      data: z.custom<PageOverview>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const { interval_days, page_id } = opts.input
    const project_id = opts.ctx.project.id
    const withAllPage = page_id === "all"

    if (!page_id) {
      return { data: [], error: "Page ID is required" }
    }

    if (withAllPage) {
      try {
        const data = await opts.ctx.analytics
          .getPagesOverview({
            interval_days,
            project_id,
          })
          .then((res) => res.data)

        return { data: data ?? [] }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to fetch pages overview"
        opts.ctx.logger.error(message, {
          project_id,
          interval_days,
        })

        return { data: [], error: message }
      }
    }

    const page = await opts.ctx.db.query.pages.findFirst({
      where: (table, { eq, and }) => and(eq(table.id, page_id), eq(table.projectId, project_id)),
    })

    if (!page) {
      return { data: [], error: "Page not found" }
    }

    try {
      const data = await opts.ctx.analytics
        .getPagesOverview({
          page_id: page.id,
          interval_days,
          project_id,
        })
        .then((res) => res.data)

      return { data: data ?? [] }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch pages overview"
      opts.ctx.logger.error(message, {
        project_id,
        interval_days,
      })

      return { data: [], error: message }
    }
  })
