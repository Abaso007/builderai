import {
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { env } from "../env"

export class LakehouseService {
  private s3: S3Client | null = null
  private bucket: string

  constructor() {
    if (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
      this.s3 = new S3Client({
        region: "auto",
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
      })
    }
    this.bucket = env.LAKEHOUSE_BUCKET ?? "unprice-lakehouse-dev"
  }

  async getSignedUrls(projectId: string, from: Date, to: Date) {
    if (!this.s3) {
      console.warn("LakehouseService: S3 client not initialized (missing env vars)")
      return { usage: [], verifications: [], metadata: [] }
    }

    const usageKeys: string[] = []
    const verificationKeys: string[] = []
    const metadataKeys: string[] = []

    let continuationToken: string | undefined = undefined

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: `${projectId}/`,
        ContinuationToken: continuationToken,
      })

      const response: ListObjectsV2CommandOutput = await this.s3.send(command)
      continuationToken = response.NextContinuationToken

      for (const obj of response.Contents ?? []) {
        const key = obj.Key
        if (!key) continue

        if (key.includes("/_metadata/")) {
          // Metadata is global for the project, needed for joins
          metadataKeys.push(key)
          continue
        }

        // Parse date from path: {projectId}/{customerId}/{year}/{month}/{day}/filename
        // We can just check if the key contains the date parts in range,
        // but simpler is to check the file timestamp if encoded in filename,
        // OR rely on the directory structure.
        // Directory structure: .../YYYY/MM/DD/...
        const parts = key.split("/")
        if (parts.length < 5) continue

        // Check if it's a usage or verification file
        const isUsage = key.includes("/usage_")
        const isVerification = key.includes("/verifications_")

        if (!isUsage && !isVerification) continue

        // Extract date from path
        // parts are [projectId, customerId, year, month, day, filename]
        // Assuming standard structure from sqlite-do-provider.ts
        // But simpler: just regex the date part
        const dateMatch = key.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//)
        if (dateMatch) {
          const [_, y, m, d] = dateMatch
          const fileDate = new Date(`${y}-${m}-${d}`)

          // Normalize check
          if (fileDate >= from && fileDate <= to) {
            if (isUsage) usageKeys.push(key)
            if (isVerification) verificationKeys.push(key)
          }
        }
      }
    } while (continuationToken)

    // Generate signed URLs
    // Limit to avoid URL too long issues or hitting rate limits?
    // S3 presigning is local crypto, fast.
    const sign = async (key: string) => {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
      return getSignedUrl(this.s3!, command, { expiresIn: 3600 })
    }

    const [usage, verifications, metadata] = await Promise.all([
      Promise.all(usageKeys.map(sign)),
      Promise.all(verificationKeys.map(sign)),
      Promise.all(metadataKeys.map(sign)),
    ])

    return { usage, verifications, metadata }
  }
}
