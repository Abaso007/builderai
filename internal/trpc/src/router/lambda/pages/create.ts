import { TRPCError } from "@trpc/server"
import * as schema from "@unprice/db/schema"
import { createSlug, newId } from "@unprice/db/utils"
import { pageInsertBaseSchema, pageSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(pageInsertBaseSchema.omit({ ctaLink: true }))
  .output(
    z.object({
      page: pageSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const { name, subdomain, customDomain, description } = opts.input
    const project = opts.ctx.project
    const _workspace = opts.ctx.project.workspace

    // only owner and admin can create a page
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const pageId = newId("page")
    const slug = createSlug()

    const pageData = await opts.ctx.db
      .insert(schema.pages)
      .values({
        id: pageId,
        slug,
        name,
        projectId: project.id,
        description,
        subdomain,
        customDomain: customDomain || null,
        faqs: [],
        colorPalette: {
          primary: "#000000",
        },
        selectedPlans: [],
      })
      .returning()
      .catch((err) => {
        opts.ctx.logger.error(err)

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create page",
        })
      })
      .then((pageData) => {
        return pageData[0]
      })

    if (!pageData?.id) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "error creating page",
      })
    }

    return {
      page: pageData,
    }
  })
