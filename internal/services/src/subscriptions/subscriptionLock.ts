import { type Database, and, eq, lt, sql } from "@unprice/db"
import { subscriptionLocks } from "@unprice/db/schema"
import { newId, randomId } from "@unprice/db/utils"

export class SubscriptionLock {
  private readonly db: Database
  private readonly projectId: string
  private readonly subscriptionId: string
  private token: string | null = null

  constructor({
    db,
    projectId,
    subscriptionId,
  }: { db: Database; projectId: string; subscriptionId: string }) {
    this.db = db
    this.projectId = projectId
    this.subscriptionId = subscriptionId
  }

  async acquire({
    ttlMs = 30_000,
    now = Date.now(),
  }: { ttlMs?: number; now?: number } = {}): Promise<boolean> {
    const token = randomId()
    const expiresAt = now + ttlMs

    try {
      await this.db.insert(subscriptionLocks).values({
        id: newId("subscription_lock"),
        projectId: this.projectId,
        subscriptionId: this.subscriptionId,
        ownerToken: token,
        expiresAt,
        createdAtM: now,
        updatedAtM: now,
      })
      this.token = token
      return true
    } catch {
      // row exists; try to take over if expired
    }

    const taken = await this.db
      .update(subscriptionLocks)
      .set({ ownerToken: token, expiresAt, updatedAtM: now })
      .where(
        and(
          eq(subscriptionLocks.projectId, this.projectId),
          eq(subscriptionLocks.subscriptionId, this.subscriptionId),
          lt(subscriptionLocks.expiresAt, now)
        )
      )
      .returning({ projectId: subscriptionLocks.projectId })
      .then((r) => r.length > 0)

    if (taken) this.token = token
    return taken
  }

  async extend({
    ttlMs = 30_000,
    now = Date.now(),
  }: { ttlMs?: number; now?: number } = {}): Promise<boolean> {
    if (!this.token) return false
    const expiresAt = now + ttlMs

    const updated = await this.db
      .update(subscriptionLocks)
      .set({ expiresAt, updatedAtM: now })
      .where(
        and(
          eq(subscriptionLocks.projectId, this.projectId),
          eq(subscriptionLocks.subscriptionId, this.subscriptionId),
          eq(subscriptionLocks.ownerToken, this.token),
          sql`${subscriptionLocks.expiresAt} > ${now}`
        )
      )
      .returning({ projectId: subscriptionLocks.projectId })
      .then((r) => r.length > 0)

    return updated
  }

  async release(): Promise<void> {
    if (!this.token) return
    const token = this.token
    this.token = null
    await this.db
      .delete(subscriptionLocks)
      .where(
        and(
          eq(subscriptionLocks.projectId, this.projectId),
          eq(subscriptionLocks.subscriptionId, this.subscriptionId),
          eq(subscriptionLocks.ownerToken, token)
        )
      )
  }
}
