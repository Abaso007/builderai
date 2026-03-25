import { TRPCError } from "@trpc/server"
import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { pageInsertBaseSchema, pageSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const update = protectedProjectProcedure
  .input(pageInsertBaseSchema.partial().required({ id: true }))
  .output(
    z.object({
      page: pageSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const {
      id,
      subdomain,
      customDomain,
      title,
      name,
      description,
      logo,
      logoType,
      colorPalette,
      faqs,
      copy,
      selectedPlans,
      ctaLink,
    } = opts.input
    const project = opts.ctx.project
    const _workspace = opts.ctx.project.workspace

    const pageData = await opts.ctx.db.query.pages.findFirst({
      where: (page, { eq, and }) => and(eq(page.id, id), eq(page.projectId, project.id)),
    })

    if (!pageData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "page not found",
      })
    }

    const updatedPage = await opts.ctx.db
      .update(schema.pages)
      .set({
        subdomain,
        customDomain,
        description,
        name,
        title,
        copy,
        logo,
        colorPalette,
        faqs,
        selectedPlans,
        logoType,
        ctaLink,
        updatedAtM: Date.now(),
      })
      .where(and(eq(schema.pages.id, id), eq(schema.pages.projectId, project.id)))
      .returning()
      .then((re) => re[0])

    if (!updatedPage) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error updating page",
      })
    }

    return {
      page: updatedPage,
    }
  })
