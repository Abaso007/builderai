import * as duckdb from "@duckdb/duckdb-wasm"

const ctx: Worker = self as any

const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles()

interface InitMessage {
  type: "INIT"
}

interface QueryMessage {
  type: "QUERY"
  payload: {
    usageUrls: string[]
    verificationUrls: string[]
    metadataUrls: string[]
  }
}

type WorkerMessage = InitMessage | QueryMessage

let db: duckdb.AsyncDuckDB | null = null
let conn: duckdb.AsyncDuckDBConnection | null = null

async function init() {
  try {
    // Select bundle
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES)

    const worker = new Worker(bundle.mainWorker!)
    const logger = new duckdb.ConsoleLogger()
    db = new duckdb.AsyncDuckDB(logger, worker)
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
    conn = await db.connect()

    console.log("DuckDB Initialized")
    postMessage({ type: "READY" })
  } catch (e: any) {
    console.error("DuckDB Init Error", e)
    postMessage({ type: "ERROR", payload: e.message })
  }
}

async function runQuery(urls: QueryMessage["payload"]) {
  if (!conn || !db) {
    postMessage({ type: "ERROR", payload: "DB not initialized" })
    return
  }

  try {
    console.log("Loading files...", urls)
    const { usageUrls, metadataUrls } = urls

    // Load Usage
    const usageList = usageUrls.map((u) => `'${u}'`).join(",")
    const metadataList = metadataUrls.map((u) => `'${u}'`).join(",")

    // Usage Table
    if (usageList.length > 0) {
      await conn.query(`
                CREATE OR REPLACE VIEW usage AS 
                SELECT * FROM read_ndjson_auto([${usageList}]);
            `)
    } else {
      // Create empty schema if no files, based on expected schema or just dummy
      // For POC, we just create a dummy that will return 0 rows for the join
      await conn.query(`CREATE OR REPLACE VIEW usage AS SELECT 1 as meta_id, 0.0 as cost LIMIT 0;`)
    }

    // Metadata Table
    if (metadataList.length > 0) {
      await conn.query(`
                CREATE OR REPLACE VIEW metadata AS 
                SELECT * FROM read_ndjson_auto([${metadataList}]);
            `)
    } else {
      await conn.query(
        `CREATE OR REPLACE VIEW metadata AS SELECT 1 as meta_id, '{}' as tags LIMIT 0;`
      )
    }

    // Perform JOIN
    // Note: We use json_extract_string to get the country code without quotes
    const query = `
            SELECT 
                json_extract_string(m.tags, '$.country') as country,
                sum(u.cost) as total_cost
            FROM usage u
            JOIN metadata m ON u.meta_id = m.meta_id
            GROUP BY country
            ORDER BY total_cost DESC
        `

    const result = await conn.query(query)
    const rows = result.toArray().map((row: any) => {
      const obj: any = {}
      // Convert Arrow/DuckDB types to JS primitives
      if (row.country !== null) obj.country = String(row.country)
      if (row.total_cost !== null) obj.total_cost = Number(row.total_cost)
      return obj
    })

    console.log("Query Result:", rows)
    postMessage({ type: "RESULT", payload: rows })
  } catch (e: any) {
    console.error("Worker Query Error", e)
    postMessage({ type: "ERROR", payload: e.message })
  }
}

ctx.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  if (e.data.type === "INIT") {
    await init()
  } else if (e.data.type === "QUERY") {
    await runQuery(e.data.payload)
  }
}
