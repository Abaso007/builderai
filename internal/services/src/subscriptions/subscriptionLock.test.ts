import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Database } from "@unprice/db"
import { SubscriptionLock } from "./subscriptionLock"

type Row = { ownerToken: string; expiresAt: number; updatedAtM: number }

// Ensure unique tokens per acquire in tests
vi.mock("@unprice/db/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unprice/db/utils")>()
  let seq = 0
  return {
    ...actual,
    randomId: () => `tok_${++seq}`,
    newId: (p: string) => `${p}_${seq}`,
  }
})

function createFakeDb(projectId: string, subscriptionId: string) {
  const key = `${projectId}:${subscriptionId}`
  const rows = new Map<string, Row>()

  const handleInsert = (v: Record<string, unknown>) => {
    const existing = rows.get(key)
    const createdAt = (v.createdAtM as number) ?? 0
    if (existing && existing.expiresAt > createdAt) {
      throw new Error("unique constraint violation")
    }
    const newRow = {
      ownerToken: String(v.ownerToken),
      expiresAt: Number(v.expiresAt),
      updatedAtM: Number(v.updatedAtM ?? createdAt),
    }
    rows.set(key, newRow)
    return [newRow]
  }

  const db = {
    transaction: vi.fn().mockImplementation(async (callback) => {
      return await callback(db)
    }),
    insert: (_table: unknown) => {
      return {
        values: (v: Record<string, unknown>) => {
          const promise = Promise.resolve().then(() => handleInsert(v))
          return Object.assign(promise, {
            returning: async () => await promise,
          })
        },
      }
    },
    update: (_table: unknown) => ({
      set: (s: Record<string, unknown>) => ({
        where: (_w: unknown) => {
          const promise = Promise.resolve().then(() => {
            const row = rows.get(key)
            if (!row) return []

            const now = Number(s.updatedAtM ?? 0)
            const isExpired = row.expiresAt < now
            const staleTakeoverMs = 120000
            const ownerStaleMs = 1000
            const isStale =
              row.expiresAt < now + staleTakeoverMs && row.updatedAtM < now - ownerStaleMs

            if (isExpired || isStale) {
              const newRow = {
                ownerToken: String(s.ownerToken ?? row.ownerToken),
                expiresAt: Number(s.expiresAt ?? row.expiresAt),
                updatedAtM: now,
              }
              rows.set(key, newRow)
              return [newRow]
            }

            if (
              row.expiresAt > now &&
              (s.ownerToken === undefined || s.ownerToken === row.ownerToken)
            ) {
              const newRow = {
                ownerToken: row.ownerToken,
                expiresAt: Number(s.expiresAt ?? row.expiresAt),
                updatedAtM: now,
              }
              rows.set(key, newRow)
              return [newRow]
            }
            return []
          })
          return Object.assign(promise, {
            returning: async () => await promise,
          })
        },
      }),
    }),
    delete: (_table: unknown) => ({
      where: async (_w: unknown) => {
        rows.delete(key)
      },
    }),
    __debug: { rows },
  }

  return db as unknown as Database
}

describe("SubscriptionLock (fake DB)", () => {
  let db: Database
  const projectId = "proj_1"
  const subscriptionId = "sub_1"

  beforeEach(() => {
    db = createFakeDb(projectId, subscriptionId)
  })

  it("acquires exclusively until release", async () => {
    const lock1 = new SubscriptionLock({ db, projectId, subscriptionId })
    const ok1 = await lock1.acquire({ now: 1000, ttlMs: 1000 })
    expect(ok1).toBe(true)

    const lock2 = new SubscriptionLock({ db, projectId, subscriptionId })
    const ok2 = await lock2.acquire({ now: 1100, ttlMs: 1000 })
    expect(ok2).toBe(false)

    await lock1.release()
    const ok3 = await lock2.acquire({ now: 1200, ttlMs: 1000 })
    expect(ok3).toBe(true)
  })

  it("allows takeover after expiry", async () => {
    const lock1 = new SubscriptionLock({ db, projectId, subscriptionId })
    expect(await lock1.acquire({ now: 1000, ttlMs: 10 })).toBe(true)

    const lock2 = new SubscriptionLock({ db, projectId, subscriptionId })
    expect(await lock2.acquire({ now: 1015, ttlMs: 10 })).toBe(true)
  })

  it("extends ownership to prevent takeover", async () => {
    const lock1 = new SubscriptionLock({ db, projectId, subscriptionId })
    expect(await lock1.acquire({ now: 1000, ttlMs: 10 })).toBe(true)
    expect(await lock1.extend({ now: 1005, ttlMs: 50 })).toBe(true)

    const lock2 = new SubscriptionLock({ db, projectId, subscriptionId })
    expect(await lock2.acquire({ now: 1010, ttlMs: 10 })).toBe(false)

    await lock1.release()
    expect(await lock2.acquire({ now: 1011, ttlMs: 10 })).toBe(true)
  })

  it("stress test: handles multiple concurrent acquisition attempts", async () => {
    const numAttempts = 50
    const locks = Array.from({ length: numAttempts }).map(
      () => new SubscriptionLock({ db, projectId, subscriptionId })
    )

    const results = await Promise.all(locks.map((lock) => lock.acquire({ now: 1000, ttlMs: 1000 })))

    const successCount = results.filter(Boolean).length
    expect(successCount).toBe(1)
  })
})
