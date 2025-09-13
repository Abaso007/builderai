import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Database } from "@unprice/db"
import { SubscriptionLock } from "./subscriptionLock"

type Row = { ownerToken: string; expiresAt: number }

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
  let lastSet: Record<string, unknown> = {}

  const db = {
    insert: (_table: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        const existing = rows.get(key)
        const createdAt = (v.createdAtM as number) ?? 0
        // if a row exists and has not expired yet at creation time, simulate conflict
        if (existing && existing.expiresAt > createdAt) throw new Error("conflict")
        rows.set(key, {
          ownerToken: String(v.ownerToken),
          expiresAt: Number(v.expiresAt),
        })
      },
    }),
    update: (_table: unknown) => ({
      set: (s: Record<string, unknown>) => {
        lastSet = s
        return {
          where: (_w: unknown) => ({
            returning: async (_sel?: unknown) => {
              const row = rows.get(key)
              const now = Number(lastSet.updatedAtM ?? 0)
              // takeover path: only if row expired
              if (row && row.expiresAt < now) {
                rows.set(key, {
                  ownerToken: String(lastSet.ownerToken ?? row.ownerToken),
                  expiresAt: Number(lastSet.expiresAt ?? row.expiresAt),
                })
                return [{}]
              }
              // extend path: only when still same owner and not expired
              if (
                row &&
                row.expiresAt > now &&
                String(lastSet.ownerToken ?? row.ownerToken) === row.ownerToken
              ) {
                rows.set(key, {
                  ownerToken: row.ownerToken,
                  expiresAt: Number(lastSet.expiresAt ?? row.expiresAt),
                })
                return [{}]
              }
              return []
            },
          }),
        }
      },
    }),
    delete: (_table: unknown) => ({
      where: async (_w: unknown) => {
        rows.delete(key)
      },
    }),
    // helpers
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
})
