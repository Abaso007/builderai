import type { StorageAdapter } from "@unprice/services/entitlements"
import { eq, like } from "drizzle-orm"
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite"
import { meterStateTable, type schema } from "./db/schema"

export class DrizzleStorageAdapter implements StorageAdapter {
  constructor(private db: DrizzleSqliteDODatabase<typeof schema>) {}

  async get<T>(key: string): Promise<T | null> {
    return this.getSync<T>(key)
  }

  getSync<T>(key: string): T | null {
    const row = this.db
      .select({ value: meterStateTable.value })
      .from(meterStateTable)
      .where(eq(meterStateTable.key, key))
      .get()

    return (row?.value as T | undefined) ?? null
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.putSync(key, value)
  }

  putSync<T>(key: string, value: T): void {
    this.db
      .insert(meterStateTable)
      .values({
        key,
        value: Number(value),
      })
      .onConflictDoUpdate({
        target: meterStateTable.key,
        set: {
          value: Number(value),
        },
      })
      .run()
  }

  async list<T>(prefix: string): Promise<T[]> {
    return this.listSync(prefix)
  }

  listSync<T>(prefix: string): T[] {
    const rows = this.db
      .select({ value: meterStateTable.value })
      .from(meterStateTable)
      .where(like(meterStateTable.key, `${prefix}%`))
      .all()

    return rows.map((row: { value: unknown }) => row.value as T)
  }
}
