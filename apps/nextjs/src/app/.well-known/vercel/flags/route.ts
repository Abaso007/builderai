import { createFlagsDiscoveryEndpoint } from "flags/next"
import { unprice } from "../../../../lib/unprice"

export const runtime = "edge"
export const dynamic = "force-dynamic"

export const GET = createFlagsDiscoveryEndpoint(async () => {
  const { result, error } = await unprice.projects.getFeatures()

  if (error) {
    throw (error instanceof Error ? error : new Error(String(error)))
  }

  const definitions = result.features.reduce(
    (acc, feature) => {
      acc[feature.slug] = {
        description: feature.description,
        defaultValue: false,
        type: "boolean",
      }
      return acc
    },
    {} as Record<string, { description: string; defaultValue: boolean; type: "boolean" }>
  )

  return { definitions }
})
