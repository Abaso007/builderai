/**
 * IcebergPathResolver.ts
 *
 * A zero-dependency Iceberg REST Catalog client for Cloudflare Workers.
 * Resolves the specific R2 storage path for a given table partition.
 */

export interface ResolverConfig {
  accountId: string
  bucketName: string
  warehouseId: string
  token: string
}

export interface PartitionPathResult {
  tableLocation: string // e.g. s3://bucket/warehouse/uuid/table
  partitionUrl: string // e.g. s3://bucket/warehouse/uuid/table/data/dt=2024-01-01/
  r2Key: string // e.g. warehouse/uuid/table/data/dt=2024-01-01/ (for R2 bindings)
}

export class IcebergPathResolver {
  private baseUrl: string
  private warehouseId: string
  private token: string
  private bucketName: string

  constructor(config: ResolverConfig) {
    this.baseUrl = `https://catalog.cloudflarestorage.com/${config.accountId}/${config.bucketName}`
    this.warehouseId = config.warehouseId
    this.token = config.token
    this.bucketName = config.bucketName
  }

  /**
   * Resolves the storage path for a specific partition.
   *
   * @param namespace - Table namespace (usually 'default')
   * @param tableName - Table name
   * @param partitionSpec - Key-value pair for partition (e.g. { date: '2024-01-01' })
   */
  async getPartitionPath(
    namespace: string,
    tableName: string,
    partitionSpec: Record<string, string | number>
  ): Promise<PartitionPathResult> {
    // 1. Fetch Table Metadata from Catalog
    // We strictly use the warehouse ID in the path as per R2 spec
    const url = `${this.baseUrl}/v1/${this.warehouseId}/namespaces/${namespace}/tables/${tableName}`

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Iceberg Catalog Error ${response.status}: ${text}`)
    }

    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const data = (await response.json()) as any

    // 2. Extract Location
    // The 'metadata' property usually contains the latest table state
    if (!data.metadata || !data.metadata.location) {
      throw new Error("Could not find table location in catalog response")
    }

    const baseLocation: string = data.metadata.location

    // 3. Construct Hive-style Partition Path
    // Format: key=value/
    const partitionPath = Object.entries(partitionSpec)
      .map(([k, v]) => `${k}=${v}`)
      .join("/")

    // 4. Combine to get full path
    const fullUrl = `${baseLocation}/data/${partitionPath}/`

    // 5. Generate R2 Key (remove s3://bucket-name/)
    // We handle the s3:// protocol prefix to get a clean key for R2 bindings
    let r2Key = fullUrl
    const s3Prefix = `s3://${this.bucketName}/`

    if (r2Key.startsWith(s3Prefix)) {
      r2Key = r2Key.slice(s3Prefix.length)
    }
    // Also handle case where protocol might be missing but bucket is present
    else if (r2Key.startsWith(`${this.bucketName}/`)) {
      r2Key = r2Key.slice(this.bucketName.length + 1)
    }

    return {
      tableLocation: baseLocation,
      partitionUrl: fullUrl,
      r2Key: r2Key,
    }
  }
}
