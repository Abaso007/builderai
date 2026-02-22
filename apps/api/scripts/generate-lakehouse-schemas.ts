import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildCloudflareLakehousePipelineDefinitions,
  toCloudflarePipelineSchema,
} from "@unprice/lakehouse"

// @ts-expect-error import.meta.url is not supported in node 20
const scriptDir = dirname(fileURLToPath(import.meta.url))
const schemaDir = resolve(scriptDir, "schemas")

async function main() {
  await mkdir(schemaDir, { recursive: true })

  const definitions = buildCloudflareLakehousePipelineDefinitions()

  for (const definition of definitions) {
    const schema = toCloudflarePipelineSchema(definition.source)
    const filePath = resolve(schemaDir, definition.schemaFile)
    const content = `${JSON.stringify(schema, null, 2)}\n`
    await writeFile(filePath, content, "utf8")
    console.log(`wrote ${filePath}`)
  }
}

main().catch((error) => {
  console.error("failed to generate lakehouse schemas", error)
  process.exit(1)
})
