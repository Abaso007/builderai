// biome-ignore lint/style/useNodejsImportProtocol: <explanation>
const fs = require("fs")
// biome-ignore lint/style/useNodejsImportProtocol: <explanation>
const path = require("path")

const dir = path.join(__dirname, "../public/duckdb")
fs.mkdirSync(dir, { recursive: true })
const dist = path.join(__dirname, "../node_modules/@duckdb/duckdb-wasm/dist")

console.info("Copying DuckDB assets from", dist, "to", dir)

try {
  for (const name of [
    "duckdb-browser-eh.worker.js",
    "duckdb-browser-mvp.worker.js",
    "duckdb-eh.wasm",
    "duckdb-mvp.wasm",
  ]) {
    fs.copyFileSync(path.join(dist, name), path.join(dir, name))
    console.info("Copied", name)
  }
} catch (err) {
  console.error("Error copying DuckDB assets:", err.message)
  console.error('Ensure you have installed dependencies with "npm install" or "pnpm install".')
  process.exit(1)
}
