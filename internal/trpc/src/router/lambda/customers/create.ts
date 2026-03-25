import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { customers } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import { customerInsertBaseSchema, customerSelectSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(customerInsertBaseSchema)
  .output(z.object({ customer: customerSelectSchema }))
  .mutation(async (opts) => {
    const {
      description,
      name,
      email,
      metadata,
      defaultCurrency,
      stripeCustomerId,
      timezone,
      externalId,
    } = opts.input
    const { project } = opts.ctx

    const _unPriceCustomerId = project.workspace.unPriceCustomerId

    // remove ip from geolocation
    const { ip, ...geolocation } = opts.ctx.geolocation
    const metadataWithGeolocation = metadata ? { ...metadata, ...geolocation } : geolocation

    const customerId = newId("customer")

    // TODO: check what happens when the currency changes?
    const customerData = await opts.ctx.db
      .insert(customers)
      .values({
        id: customerId,
        name,
        email,
        projectId: project.id,
        description,
        timezone: timezone || "UTC",
        active: true,
        ...(metadataWithGeolocation && { metadata: metadataWithGeolocation }),
        ...(externalId && { externalId }),
        ...(defaultCurrency && { defaultCurrency }),
        ...(stripeCustomerId && { stripeCustomerId }),
      })
      .returning()
      .then((data) => data[0])

    if (!customerData) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error creating customer",
      })
    }

    return {
      customer: customerData,
    }
  })
