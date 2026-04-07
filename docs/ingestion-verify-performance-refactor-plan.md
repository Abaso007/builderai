# Ingestion Verify Performance Refactor Plan (1/2/3)

## Goal

Implement the agreed changes to improve verify latency and correctness, with **no backward compatibility constraints**:

1. Remove duplicate customer validation/fetch.
2. Reduce DB query count in grant loading.
3. Simplify verify path to avoid unnecessary grant-context wrappers and cache bucketing logic.

## Current Baseline (as of 2026-04-07)

- `IngestionPreparationService.prepareCustomerGrantContext()` calls `customerService.getCustomer()` and then `grantsManager.getGrantsForCustomer()` (duplicate customer existence check).
- `GrantsManager.getGrantsForCustomer()` loads customer/subscription scope, then executes one `grants.findMany` per subject (`customer`, `project`, `plan`, `plan_version`) using `Promise.all`.
- `IngestionService.verifyFeatureStatus()` calls `prepareCustomerGrantContextForVerify()` which applies `cachedQuery` + bucket key logic (`VERIFY_GRANT_CONTEXT_CACHE_BUCKET_MS`) before resolving feature state.
- API wiring and cache namespace include `ingestionPreparedGrantContext` specifically for this verify wrapper.

## Implementation Plan

## Step 1: Introduce explicit customer-not-found grant-context error

### Why
We need a typed signal from entitlements layer so ingestion can map to `CUSTOMER_NOT_FOUND` without pre-loading customer in another service.

### Changes
- Add `CustomerGrantContextNotFoundError` in `internal/services/src/entitlements/errors.ts`.
- Keep it as a domain error (non-retryable), include `subjectId` and `subjectSource: "customer"` when available.

### Acceptance
- Error is exported and can be used in both `grants.ts` and ingestion services/tests.

## Step 2: Refactor `GrantsManager` to load scope once and query grants once

### Why
Current path performs multiple queries and duplicates responsibility across services.

### Changes
- In `internal/services/src/entitlements/grants.ts`:
  - Extract `loadCustomerGrantScope(...)` helper that:
    - validates customer belongs to project,
    - loads subscription/phase/planVersion context for time window,
    - returns normalized subject list.
  - Replace per-subject `Promise.all(...findMany...)` in `getGrantsForCustomer(...)` with a **single grants query** using OR-ed subject predicates.
  - Keep period overlap logic identical (effective/expires constraints) to avoid behavior regressions.
- Optional but recommended in same step:
  - Add `resolveFeatureStateForCustomerAtTimestamp(...)` to encapsulate:
    - scope load,
    - feature grants fetch,
    - `resolveFeatureStateAtTimestamp(...)` call.

### Acceptance
- `getGrantsForCustomer()` performs one grants fetch for all subjects.
- Missing customer/project returns `CustomerGrantContextNotFoundError`.
- Existing ingestion state resolution outputs remain semantically equivalent.

## Step 3: Remove duplicate customer fetch from ingestion preparation

### Why
`IngestionPreparationService` should rely on grants layer for customer/project validation.

### Changes
- In `internal/services/src/ingestion/preparation-service.ts`:
  - Remove `CustomerService` dependency and constructor argument.
  - Replace `getCustomer` pre-check with `grantsManager.getGrantsForCustomer(...)`.
  - Catch/map `CustomerGrantContextNotFoundError` to `rejectionReason: "CUSTOMER_NOT_FOUND"`.
- Update construction sites accordingly.

### Acceptance
- No `customerService.getCustomer()` call in preparation path.
- Rejection behavior for missing customer remains unchanged at API contract level.

## Step 4: Simplify verify path in `IngestionService`

### Why
Current verify wrapper adds bucket-key complexity and can trigger redundant grant-context reload patterns.

### Changes
- In `internal/services/src/ingestion/service.ts`:
  - Remove:
    - `VERIFY_GRANT_CONTEXT_CACHE_BUCKET_MS`,
    - `prepareCustomerGrantContextForVerify(...)`,
    - `cachedQuery` import/usage,
    - `cache` and `customerService` constructor dependencies (if no longer needed elsewhere).
  - Update `verifyFeatureStatus(...)` to resolve directly via grants layer:
    - preferred: call `grantsManager.resolveFeatureStateForCustomerAtTimestamp(...)` (if added in Step 2),
    - fallback: call `getGrantsForCustomer(...)` + `resolveFeatureStateAtTimestamp(...)` directly.
  - Error mapping:
    - `CustomerGrantContextNotFoundError` -> `status: "customer_not_found"`,
    - domain config errors -> `status: "invalid_entitlement_configuration"`,
    - fetch/infra errors -> throw (preserve retry semantics).

### Acceptance
- Verify no longer depends on ingestion-specific grant-context cache/bucketing.
- Verify correctness behavior remains same for `feature_missing`, `feature_inactive`, `non_usage`, `usage`, and invalid config branches.

## Step 5: Remove now-unneeded ingestion verify cache wiring

### Why
After Step 4, the dedicated cache namespace becomes dead code.

### Changes
- Remove `ingestionPreparedGrantContext` from:
  - `internal/services/src/cache/namespaces.ts`
  - `internal/services/src/cache/service.ts`
  - `apps/api/src/ingestion/service.ts`
  - `apps/api/src/ingestion/queue.ts`
  - `apps/api/src/middleware/init.ts`
  - any ingestion harness/stub cache setup.

### Acceptance
- Ingestion service factories no longer require cache specifically for verify grant-context caching.
- Type-check passes without `ingestionPreparedGrantContext`.

## Step 6: Update tests to match new ownership and query behavior

### Changes
- Update ingestion harness:
  - `internal/services/src/ingestion/testing/serviceTestHarness.ts`
  - remove verify cache stub and `getCustomer` mock dependency where obsolete.
- Update ingestion service tests:
  - `internal/services/src/ingestion/service.test.ts`
  - remove/replace bucket-crossing cache test,
  - adjust call-count assertions to reflect no duplicate customer fetch.
- Update API factory test:
  - `apps/api/src/ingestion/service.factory.test.ts`
  - remove `cache.ingestionPreparedGrantContext` setup.
- Update grants tests:
  - `internal/services/src/entitlements/grants.test.ts`
  - adapt mocks for single grants query strategy,
  - add explicit tests for customer-not-found typed error.

### Acceptance
- All touched test suites green.

## Validation Commands

Run in repository root:

```bash
pnpm --filter @unprice/services exec vitest run src/entitlements/grants.test.ts
pnpm --filter @unprice/services exec vitest run src/ingestion/service.test.ts
pnpm --filter @unprice/services exec tsc --noEmit
pnpm --filter api exec vitest run src/ingestion/service.factory.test.ts
pnpm --filter api exec tsc --noEmit
```

## Rollout Notes For The Implementing Agent

- Keep commits small and ordered by steps above (error type -> grants refactor -> ingestion refactor -> cache cleanup -> tests).
- Avoid behavior changes in entitlement math; this refactor is about data loading and ownership boundaries.
- If query shape changes in `grants.ts`, verify Drizzle relations still return `featurePlanVersion.feature` consistently for state resolution.
