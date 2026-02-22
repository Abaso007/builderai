import type { Analytics, PageBrowserVisits } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getBrowserVisits = protectedProjectProcedure
  .input(z.custom<Parameters<Analytics["getBrowserVisits"]>[0]>())
  .output(
    z.object({
      data: z.custom<PageBrowserVisits>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const { interval_days, page_id } = opts.input
    const project_id = opts.ctx.project.id

    if (!page_id || page_id === "_" || page_id === "") {
      return { data: [], error: "Page ID is required" }
    }

    const page = await opts.ctx.db.query.pages.findFirst({
      where: (table, { eq, and }) => and(eq(table.id, page_id), eq(table.projectId, project_id)),
    })

    if (!page) {
      return { data: [], error: "Page not found" }
    }

    try {
      const data = await opts.ctx.analytics
        .getBrowserVisits({
          page_id: page.id,
          interval_days,
          project_id: project_id,
        })
        .then((res) => res.data)

      return { data: data ?? [] }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch browser visits"
      opts.ctx.logger.error(message, {
        project_id,
        interval_days,
      })

      return { data: [], error: message }
    }
  })
