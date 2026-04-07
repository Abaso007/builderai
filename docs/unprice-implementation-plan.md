# Unprice Unified Billing — Refined Implementation Plan

> This plan is designed to be executed by an agent, one phase per PR, one
> commit per todo item when practical. If a commit fails hooks or tests, fix it
> before moving on. If the plan conflicts with what the code actually does,
> update the plan before continuing.

## Progress Tracking

**After completing each numbered item (for example `1.1`, `1.2`), mark it as
completed by prepending `[x]` to the item title in this document and commit the
change.**

Example:
```
Before: **1.1 — Create RatingService shell**
After:  **[x] 1.1 — Create RatingService shell**
```

This keeps the plan usable as a living handoff document.

---

## Current-Code Conventions

Before starting any phase, align with the code that exists today.

**Service structure:**
```
internal/services/src/[service-name]/
  ├── service.ts
  ├── errors.ts
  ├── index.ts
  └── *.test.ts
```

**Composition root:** [internal/services/src/context.ts](/Users/jhonsfran/repos/unprice/internal/services/src/context.ts)
Build services in dependency order inside `createServiceContext(deps)`.

**Shared infrastructure deps:** [internal/services/src/deps.ts](/Users/jhonsfran/repos/unprice/internal/services/src/deps.ts)
The current shared contract is `ServiceDeps = { db, logger, analytics, waitUntil, cache, metrics }`.
Use that shape as the baseline for new services.

**DB schema barrel:** [internal/db/src/schema.ts](/Users/jhonsfran/repos/unprice/internal/db/src/schema.ts)
Tables live under `internal/db/src/schema/` and are re-exported from `schema.ts`.

**DB validator barrel:** [internal/db/src/validators.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators.ts)
Do not export from a non-existent `internal/db/src/validators/index.ts`.

**Use-case barrel:** [internal/services/src/use-cases/index.ts](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/index.ts)
Use cases are async functions and should be re-exported here.

**Pure pricing math (already extracted):** [internal/db/src/validators/subscriptions/prices.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators/subscriptions/prices.ts)
`calculateWaterfallPrice()`, `calculatePricePerFeature()`, `calculateFreeUnits()`, `calculateTierPrice()`, `calculatePackagePrice()`, and `calculateUnitPrice()` are pure functions with no service dependencies. They live in the validators package and must remain the single source of pricing math.

**Current pricing orchestration seam:** [internal/services/src/billing/service.ts](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts)
`BillingService.calculateFeaturePrice()` orchestrates grant fetching, usage fetching, billing-window calculation, proration, and waterfall-input preparation before calling the pure pricing functions above. This orchestration is the extraction target for `RatingService`.

**Current provider interface (already provider-agnostic):** [internal/services/src/payment-provider/interface.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/interface.ts)
`PaymentProviderInterface` exposes 15 methods (sessions, invoicing, payment methods) with normalized types. No Stripe types leak through the interface itself. The coupling is in the resolver, customer metadata, and callback routes — not the interface.

**Current provider seam:** [internal/services/src/payment-provider/resolver.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/resolver.ts)
This class already resolves provider config, decrypts provider secrets, and derives the provider customer id. Prefer evolving this seam instead of bypassing it.

**Current source-of-truth reminders:**
- `plan_versions.paymentProvider` is the current provider source of truth.
- `customers.stripeCustomerId` is still actively read and written (13 files). It has a **global uniqueness constraint** (`stripe_customer_unique`) that is NOT project-scoped — this is a multi-tenancy bug.
- Customer metadata stores Stripe-specific fields: `stripeSubscriptionId`, `stripeDefaultPaymentMethodId`.
- `PaymentProviderResolver.getProviderCustomerId()` (resolver.ts L130) hardcodes a `stripeCustomerId` fallback.
- sync ingestion currently requires `customerId` in the request body. No API-key-to-customer mapping exists.
- `EntitlementWindowDO.apply()` currently returns only `{ allowed, deniedReason, message }` but the DO already computes and writes `delta` and `value_after` to its analytics outbox.

**Migration command:**
From `internal/db/`, use the package script in [internal/db/package.json](/Users/jhonsfran/repos/unprice/internal/db/package.json):
```bash
pnpm generate
```

---

## Architectural Rules For This Plan

1. Extract shared logic before adding new behavior.
2. Do not worry about backward compatibility.
3. Do not mark ledger entries settled until some existing runtime path can actually consume that settlement state.
4. Do not introduce a second pricing implementation — reuse the pure functions in `@unprice/db/validators/subscriptions/prices.ts`. For real-time incremental rating, use the marginal approach (call `calculatePricePerFeature()` at `usage_before` and `usage_after`, take the delta). For batch/period-end rating, use the full waterfall. Both use the same underlying math.
5. Keep new types near the service layer unless they are truly DB-facing types.
6. Preserve existing Stripe callback routes until generic provider flows reach parity.
7. Keep `LedgerService` as a leaf service (no service dependencies). `BillingService` calls into `LedgerService`, never the reverse — avoids circular deps in the composition root.
8. Fix coupling at specific points (resolver, metadata, routes) rather than adding abstraction layers on top of already-abstract interfaces.

---

## Phase 1: Extract Pricing Orchestration Into RatingService

> **PR title:** `feat: extract pricing orchestration into RatingService`
>
> **Goal:** Extract the pricing orchestration layer (grant resolution, usage
> fetching, proration, waterfall-input preparation) from `BillingService` into
> `RatingService`. The pure pricing math already lives in
> `@unprice/db/validators/subscriptions/prices.ts` — this phase extracts the
> service-layer pipeline that feeds it.
>
> **Branch:** `feat/rating-service`

### What stays where

| Layer | Location | Responsibility |
|-------|----------|----------------|
| **Pure pricing math** | `@unprice/db/validators/subscriptions/prices.ts` | `calculateWaterfallPrice`, `calculatePricePerFeature`, `calculateFreeUnits`, tier/unit/package calculators. Already extracted. Do not move. |
| **Pricing orchestration** (extract target) | Currently `BillingService.calculateFeaturePrice()` | Grant fetching + filtering, entitlement state computation, billing window calculation, usage fetching, per-grant proration, waterfall-input preparation, result mapping. |
| **Invoice domain logic** (stays in BillingService) | `BillingService._computeInvoiceItems()` | Invoice item formatting, descriptions, credit items, provider reconciliation. |

### Commits

**1.1 — Create rating module shell**

Create `internal/services/src/rating/` with:
- `errors.ts` — `UnPriceRatingError`
- `service.ts` — `RatingService`
- `types.ts` — service-layer types such as `RatedCharge`, `RatingInput`
- `index.ts` — barrel exports

Constructor deps:
- Infrastructure: `db`, `logger`, `analytics`, `cache`, `metrics`, `waitUntil` (from `ServiceDeps`)
- Services: `grantsManager: GrantsManager` (same layer as `BillingService`)

Notes:
- Keep `RatedCharge` in the service layer, not in `@unprice/db/validators`.
- Match the current error pattern from [internal/services/src/billing/errors.ts](/Users/jhonsfran/repos/unprice/internal/services/src/billing/errors.ts).

Files to read first:
- [internal/services/src/billing/errors.ts](/Users/jhonsfran/repos/unprice/internal/services/src/billing/errors.ts)
- [internal/services/src/deps.ts](/Users/jhonsfran/repos/unprice/internal/services/src/deps.ts)
- [internal/services/src/context.ts](/Users/jhonsfran/repos/unprice/internal/services/src/context.ts) — understand construction order

**1.2 — Extract pricing orchestration from `calculateFeaturePrice()`**

Move the orchestration pipeline out of `BillingService.calculateFeaturePrice()` into `RatingService`. This is the core extraction step.

What to extract (the pipeline inside `calculateFeaturePrice()` after ~L2407):
1. Fetch grants via `grantsManager.getGrantsForCustomer()` (unless pre-fetched)
2. Filter grants to the target feature by slug
3. Compute entitlement state via `grantsManager.computeEntitlementState()`
4. Calculate billing window (cycle calculation or grant effective dates)
5. Fetch usage from Analytics (unless provided)
6. Calculate per-grant proration via `calculateGrantProration()`
7. Prepare waterfall inputs: priority, limits, free units, proration factors
8. Call `calculateWaterfallPrice()` (the existing pure function in validators)
9. Map waterfall results to `ComputeCurrentUsageResult[]`

Also extract `calculateGrantProration()` (~L2311) — it computes the intersection of grant active period and billing window, then applies proration factor.

Important constraints:
- This step must preserve existing behavior exactly.
- `BillingService` should delegate to the extracted logic rather than maintain a fork.
- The pure math functions in `@unprice/db/validators/subscriptions/prices.ts` stay where they are.
- Pre-fetched grants and usage must remain supported (the batch optimization in `estimatePriceCurrentUsage` depends on this).

Files to read first:
- [internal/services/src/billing/service.ts#L2363](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L2363) — `calculateFeaturePrice()`
- [internal/services/src/billing/service.ts#L2311](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L2311) — `calculateGrantProration()`
- [internal/services/src/entitlements/grants.ts#L464](/Users/jhonsfran/repos/unprice/internal/services/src/entitlements/grants.ts#L464) — grant proration helpers
- [internal/db/src/validators/subscriptions/prices.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators/subscriptions/prices.ts) — pure pricing functions (do not move these)

**1.3 — Register RatingService in the service graph**

- Add `rating: RatingService` to `ServiceContext`
- Construct it in [internal/services/src/context.ts](/Users/jhonsfran/repos/unprice/internal/services/src/context.ts) at the leaf tier (same level as `billing`, after `grantsManager`)
- Export it from [internal/services/package.json](/Users/jhonsfran/repos/unprice/internal/services/package.json)

**1.4 — Make BillingService delegate pricing to RatingService**

Update `BillingService` to call `RatingService` for:
- `_computeInvoiceItems` — replace inline `calculateFeaturePrice()` calls
- `estimatePriceCurrentUsage` — replace inline `calculateFeaturePrice()` calls
- any other direct `calculateFeaturePrice()` call sites

BillingService constructor gains: `ratingService: RatingService`.

Important constraints:
- Keep the invoice-item formatting, description generation, and credit-item logic in `BillingService`.
- Keep the batch-optimization loop in `estimatePriceCurrentUsage` (groups features by billing window for efficient analytics queries). `RatingService` should accept pre-fetched grants and usage to support this.
- This step is about extracting computation, not changing the invoice persistence flow.

Files to read first:
- [internal/services/src/billing/service.ts#L1034](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L1034) — `_computeInvoiceItems()`
- [internal/services/src/billing/service.ts#L2778](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L2778) — `estimatePriceCurrentUsage()`

**1.5 — Add `rateBillingPeriod()` as a public RatingService method**

Implement `rateBillingPeriod()` only after the shared orchestration exists.

Requirements:
- Reuses the same extracted orchestration already used by `BillingService`.
- Returns a service-layer `RatedCharge[]` projection.
- Does not introduce a second usage-fetching or grant-resolution algorithm.

**1.6 — Add `rateIncrementalUsage()` using marginal pricing**

Implement incremental usage rating using the marginal approach.

Algorithm:
- Accepts `featureSlug`, `customerId`, `usageBefore`, `usageAfter`, `grantConfig`
- Calls `calculatePricePerFeature(usageAfter, config)` minus `calculatePricePerFeature(usageBefore, config)`
- Returns the delta as the incremental charge

This approach:
- Correctly handles tiered pricing (usage crossing tier boundaries)
- Correctly handles package pricing (delta = packages_after - packages_before)
- Works in real-time without re-running the full waterfall
- Uses the same `calculatePricePerFeature()` function as the batch path

Important constraints:
- Resolve grants through `GrantsManager` to get the active grant config
- For the full waterfall case (multiple grants with priority), use `rateBillingPeriod()` instead
- This method is specifically for the single-event, single-grant, real-time case used by agent billing

**1.7 — Write unit tests for RatingService and delegated BillingService behavior**

Add tests for:
- extracted orchestration parity with current `calculateFeaturePrice()` behavior
- `rateIncrementalUsage` for flat pricing (delta = unit_price * usage_delta)
- `rateIncrementalUsage` for tier boundary crossings (price jump at tier edge)
- `rateIncrementalUsage` for package pricing (step function behavior)
- missing grants / empty-grant behavior
- `BillingService` continuing to produce the same invoice item totals through delegation
- pre-fetched grants and usage path (batch optimization support)

Files to read first:
- [internal/services/src/plans/plans.test.ts](/Users/jhonsfran/repos/unprice/internal/services/src/plans/plans.test.ts)
- [internal/db/src/validators/subscriptions/prices.test.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators/subscriptions/prices.test.ts)

---

## Phase 2: Provider Mapping Foundation

> **PR title:** `feat: add provider mapping foundation`
>
> **Goal:** Introduce provider-agnostic storage without breaking the current
> Stripe-backed customer and callback flows.
>
> **Branch:** `feat/provider-mapping-foundation`

### Commits

**2.1 — Fix `stripeCustomerId` global uniqueness constraint**

The current `stripe_customer_unique` constraint on `customers.stripeCustomerId` is globally unique instead of project-scoped. This breaks multi-tenancy.

Requirements:
- Drop the global unique constraint `stripe_customer_unique`
- Add composite unique constraint on `(stripe_customer_id, project_id)` instead
- Verify no existing data violates the new constraint

Files to read first:
- [internal/db/src/schema/customers.ts](/Users/jhonsfran/repos/unprice/internal/db/src/schema/customers.ts) — line 40

**2.2 — Add `customer_provider_ids` table**

Create a provider mapping table for external customer ids.

Requirements:
- composite primary key using `projectID` pattern (CUID id + projectId)
- one row per `(projectId, customerId, provider)`
- unique lookup by `(projectId, provider, providerCustomerId)`
- composite foreign key back to `customers` using `(customerId, projectId)`
- `provider` column using existing `paymentProviderEnum`
- `providerCustomerId` text column for the external ID
- `metadata` JSON column for provider-specific data (replaces Stripe-specific customer metadata fields like `stripeSubscriptionId`, `stripeDefaultPaymentMethodId`)
- export from [internal/db/src/schema.ts](/Users/jhonsfran/repos/unprice/internal/db/src/schema.ts)
- define Drizzle relations in the schema file

**2.3 — Add `apikey_customers` table**

Create a mapping table between API keys and customers.

Requirements:
- composite primary key using `projectID` pattern
- unique lookup by `(projectId, apikeyId)`
- composite foreign keys to `apikeys` and `customers` using `(id, projectId)` pattern
- export from the schema barrel
- define Drizzle relations

**2.4 — Add webhook event storage**

Create `webhook_events` for idempotent provider webhook processing.

Requirements:
- composite primary key using `projectID` pattern
- unique lookup by `(projectId, provider, providerEventId)`
- `provider` column using `paymentProviderEnum`
- `status` enum (new `pgEnum`) with at least `pending`, `processed`, `failed`
- `payload` JSON column and `error` text column for replay/debugging
- `timestamps` fields
- export from the schema barrel

**2.5 — Extend payment provider config for webhook verification**

Current provider config stores only the encrypted API key (`key` + `keyIv`).
Before the webhook phase, add storage for webhook verification secrets.

Requirements:
- Add `webhookSecret` text column (encrypted, same pattern as `key`)
- Add `webhookSecretIv` text column (IV for decryption)
- Both nullable (not all providers use webhook secrets)

Important constraint:
- Keep encryption handling aligned with the existing `AesGCM` flow using `env.ENCRYPTION_KEY`.
- Decryption follows the same pattern: `aesGCM.decrypt({ iv: config.webhookSecretIv, ciphertext: config.webhookSecret })`.

Files to read first:
- [internal/db/src/schema/paymentConfig.ts](/Users/jhonsfran/repos/unprice/internal/db/src/schema/paymentConfig.ts) — current `key`/`keyIv` pattern
- [internal/db/src/validators/paymentConfig.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators/paymentConfig.ts)
- [internal/services/src/payment-provider/resolver.ts#L86](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/resolver.ts#L86) — existing `AesGCM` decryption

**2.6 — Add validators and export them from the real barrel**

Add validators for:
- `customer_provider_ids`
- `apikey_customers`
- `webhook_events`

Export from:
- [internal/db/src/validators.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators.ts)

**2.6 — Add `paymentProvider` snapshot to `subscription_phases` as additive state**

If this denormalized column is needed, add it as a snapshot field only.

Important constraint:
- Do not switch all readers immediately.
- `plan_versions.paymentProvider` remains the source of truth until all runtime readers are migrated.

Files to read first:
- [internal/db/src/schema/planVersions.ts#L73](/Users/jhonsfran/repos/unprice/internal/db/src/schema/planVersions.ts#L73)
- [internal/db/src/schema/subscriptions.ts](/Users/jhonsfran/repos/unprice/internal/db/src/schema/subscriptions.ts)

**2.7 — Generate migration with the project script**

From `internal/db/`, run:
```bash
pnpm generate
```

Do not edit the generated SQL by hand unless there is a repo-specific migration policy requiring it.

**2.8 — Add dual-read and dual-write migration notes to the plan implementation**

This phase is not complete until the rollout strategy is explicit:
- continue reading `customers.stripeCustomerId` during transition
- write to both legacy Stripe fields and `customer_provider_ids`
- backfill existing Stripe customer ids into the new mapping table
- only remove legacy reads after all callbacks and resolver paths are migrated

Files to read first:
- [internal/services/src/payment-provider/resolver.ts#L106](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/resolver.ts#L106)
- [internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts#L160](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts#L160)
- [internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts#L132](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts#L132)

---

## Phase 3: Decouple Provider-Specific Coupling Points

> **PR title:** `feat: decouple provider-specific coupling points`
>
> **Goal:** Fix the four specific points where Stripe leaks through the
> provider-agnostic interface: (1) resolver hardcodes `stripeCustomerId`,
> (2) customer metadata stores Stripe-specific fields, (3) callback routes are
> Stripe-specific, (4) Stripe implementation has provider-specific behavior
> (billing portal, tax IDs). The existing `PaymentProviderInterface` is already
> provider-agnostic — no new abstraction layer needed.
>
> **Branch:** `feat/provider-decoupling`

### Commits

**3.1 — Define normalized provider metadata schema**

Replace Stripe-specific customer metadata fields with a provider-agnostic structure.

Current state (in customer metadata):
```typescript
{ stripeSubscriptionId, stripeDefaultPaymentMethodId, country, region, city }
```

Target state (stored in `customer_provider_ids.metadata` from Phase 2):
```typescript
{ subscriptionId?, defaultPaymentMethodId?, ... } // per-provider row
```

Requirements:
- Define a `ProviderCustomerMetadata` type in `internal/services/src/payment-provider/`
- Country/region/city stay on customer metadata (they're not provider-specific)
- Provider-specific fields move to the `customer_provider_ids.metadata` column

Files to read first:
- [internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts#L174](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts#L174) — current Stripe metadata writes
- [internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts#L136](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts#L136)

**3.2 — Update `PaymentProviderResolver` to use `customer_provider_ids`**

Migrate provider customer ID resolution from `customers.stripeCustomerId` to the new mapping table.

Current broken code (resolver.ts ~L130):
```typescript
return customerData?.stripeCustomerId ?? undefined  // ALWAYS returns Stripe ID
```

Target:
```typescript
// Query customer_provider_ids by (projectId, customerId, provider)
// Fall back to customers.stripeCustomerId during transition (dual-read)
```

Requirements:
- Query `customer_provider_ids` first
- Fall back to `customers.stripeCustomerId` if not found (dual-read during migration)
- Keep the resolver responsible for config loading, secret decryption, and customer ID resolution
- Do not move secret decryption or config lookup into random call sites
- Load webhook secret from the new `webhookSecret`/`webhookSecretIv` columns when requested

Files to read first:
- [internal/services/src/payment-provider/resolver.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/resolver.ts) — full file
- [internal/db/src/schema/customers.ts](/Users/jhonsfran/repos/unprice/internal/db/src/schema/customers.ts) — `stripeCustomerId` field

**3.3 — Update CustomerService for dual-write**

Migrate `CustomerService.getPaymentProvider()` and customer creation/update to dual-write.

Requirements:
- On customer creation with a provider ID: write to both `customers.stripeCustomerId` AND `customer_provider_ids`
- On customer update with a provider ID: update both locations
- Keep current call sites working while the migration is in progress
- `getPaymentProvider()` delegates to resolver (which now dual-reads)

Files to read first:
- [internal/services/src/customers/service.ts#L1127](/Users/jhonsfran/repos/unprice/internal/services/src/customers/service.ts#L1127)

**3.4 — Handle provider-specific behavior in implementations**

Address the Stripe-specific behaviors that don't generalize:
- **Billing portal redirect** (stripe.ts L89-94): If customer already has provider ID, Stripe creates a billing portal session. Other providers need different UX. Add a capability flag or conditional path.
- **Tax ID collection** (stripe.ts L107-109): Hardcoded `tax_id_collection: { enabled: true }`. Make configurable or provider-conditional.
- **Invoice reconciliation** (billing/service.ts ~L1428): The item-by-item `addInvoiceItem`/`updateInvoiceItem` pattern assumes provider supports line items. Document this assumption; do not force it into a single `createInvoice(items)` call.

Important constraint:
- Preserve current invoice verification behavior (total matching).

Files to read first:
- [internal/services/src/payment-provider/stripe.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/stripe.ts)
- [internal/services/src/payment-provider/sandbox.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/sandbox.ts)
- [internal/services/src/billing/service.ts#L1428](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L1428)

**3.5 — Add generic provider callback use case without deleting Stripe routes yet**

Create a provider-agnostic callback completion use case.

Requirements:
- Write provider mappings through `customer_provider_ids` (primary)
- Continue dual-writing `customers.stripeCustomerId` during transition
- Store provider metadata in `customer_provider_ids.metadata` instead of customer metadata
- Keep existing Stripe routes alive until the generic route has test parity

Files to read first:
- [internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts)
- [internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts)
- [apps/api/src/routes/paymentProvider/stripeSignUpV1.ts](/Users/jhonsfran/repos/unprice/apps/api/src/routes/paymentProvider/stripeSignUpV1.ts)
- [apps/api/src/routes/paymentProvider/stripeSetupV1.ts](/Users/jhonsfran/repos/unprice/apps/api/src/routes/paymentProvider/stripeSetupV1.ts)

**3.6 — Write tests for resolver dual-read and callback parity**

Add tests for:
- resolver dual-read: returns from `customer_provider_ids` when available, falls back to `stripeCustomerId`
- resolver returns `undefined` provider customer ID when neither source has data
- callback use case writes to both `customer_provider_ids` and legacy `stripeCustomerId`
- provider metadata stored in mapping table, not customer metadata
- migration parity: generic callback produces same customer state as current Stripe-specific callbacks

---

## Phase 4: Idempotent Ledger With Billing Consumption

> **PR title:** `feat: add idempotent ledger with billing consumption`
>
> **Goal:** Introduce append-only ledger storage that is safe under retries,
> and immediately wire it into `BillingService` so ledger debits become
> invoiceable items. Settlement routing is deferred to Phase 6 (Agent Billing)
> where an actual consumer exists beyond subscription billing.
>
> **Branch:** `feat/ledger-foundation`

### Why merged

The original plan had a separate Phase 5 ("Make Billing Consume Ledger Entries")
between ledger creation and settlement. But subscription billing already works
end-to-end. A settlement router without agent billing has no consumer. Instead:
- This phase builds the ledger AND wires it into billing in one PR.
- Settlement routing moves to Phase 6 where agent billing creates real demand.

### Commits

**4.1 — Add ledger schema**

Add `ledgers` and `ledger_entries` tables.

Requirements:
- composite primary key using `projectID` pattern (CUID id + projectId)
- one ledger per `(projectId, customerId, currency)` — unique composite constraint
- composite foreign key to `customers` using `(customerId, projectId)`
- `currency` using existing `currencyEnum`
- append-only `ledger_entries` with:
  - composite FK to `ledgers` using `(ledgerId, projectId)`
  - `type` enum: `debit`, `credit` (new `pgEnum`)
  - `amount` integer (cents)
  - `runningBalance` integer (computed in transaction)
  - `sourceType` text + `sourceId` text — deterministic idempotency key
  - unique constraint on `(ledgerId, sourceType, sourceId)` — prevents duplicate postings
  - `settled` boolean default false
  - `settledAt` timestamp nullable
  - `settlementType` enum: `invoice`, `wallet`, `one_time`, `reversal` (nullable until settled)
  - `settlementId` text nullable (links to invoice/wallet/payment record)
  - `timestamps` fields

Important constraint:
- The unique `(ledgerId, sourceType, sourceId)` constraint provides deterministic deduplication of retried postings at the DB level.
- Do not rely on callers to "just not retry".

**4.2 — Add ledger enums and validators**

Add enums and validator exports for ledger rows.

Requirements:
- New `pgEnum` for `ledger_entry_type` (`debit`, `credit`)
- New `pgEnum` for `settlement_type` (`invoice`, `wallet`, `one_time`, `reversal`)
- Export through the real schema and validator barrels
- Generate migration: `pnpm generate` from `internal/db/`

**4.3 — Create LedgerService shell**

Create `internal/services/src/ledger/` with:
- `errors.ts` — `UnPriceLedgerError`
- `service.ts` — `LedgerService`
- `index.ts` — barrel exports

Constructor deps: Infrastructure only (`db`, `logger`, `metrics`). No service dependencies.

Important constraint:
- `LedgerService` MUST be a leaf service (no deps on other services). This prevents circular dependencies since `BillingService` will depend on `LedgerService`.

**4.4 — Implement idempotent `postDebit()` and `postCredit()`**

Requirements:
- Deterministic source identity: `sourceType + sourceId` pair (e.g., `sourceType: "invoice_item"`, `sourceId: invoiceItemId`)
- Retries with the same source identity return the existing entry (upsert/ON CONFLICT DO NOTHING + SELECT)
- Running balance derived within a serializable transaction
- Auto-create ledger for `(projectId, customerId, currency)` if it doesn't exist

Important constraint:
- Billing currently retries invoice finalization in failure scenarios (`_upsertPaymentProviderInvoice` at ~L1632), so ledger posting must tolerate repeated attempts.

Files to read first:
- [internal/services/src/billing/service.ts#L1632](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L1632) — retry scenarios in billing

**4.5 — Implement `getUnsettledBalance()`, `getUnsettledEntries()`, and `markSettled()`**

Add read and state-transition methods for unsettled ledger entries.

Requirements:
- `getUnsettledEntries(ledgerId, opts?)` — returns entries where `settled = false`, optionally filtered by `sourceType`
- `getUnsettledBalance(ledgerId)` — sum of unsettled entries
- `markSettled(entryIds[], settlementType, settlementId)` — batch mark entries as settled within a transaction

Important constraint:
- `markSettled()` should be reserved for flows that already have a real downstream consumer or confirmed payment result.

**4.6 — Register LedgerService in the service graph**

- Add `ledger: LedgerService` to `ServiceContext`
- Construct it in [internal/services/src/context.ts](/Users/jhonsfran/repos/unprice/internal/services/src/context.ts) at the **leaf tier** (before `billing`)
- Wire `ledgerService` into `BillingService` constructor
- Export it from [internal/services/package.json](/Users/jhonsfran/repos/unprice/internal/services/package.json)

**4.7 — Post invoice-backed debits from BillingService**

When wiring the ledger into billing:
- Use stable source ids tied to invoice and item identity: `sourceType: "invoice_item"`, `sourceId: invoiceItem.id`
- Post debits during `_computeInvoiceItems` or `_upsertPaymentProviderInvoice`
- Avoid duplicate posting on retries (the unique constraint handles this)
- Skip zero-value debits

Important constraint:
- This step only writes debits that correspond to known internal billing artifacts.

**4.8 — Teach BillingService to discover unsettled ledger debits**

Add the bridge between ledger debits and invoice lines.

Requirements:
- During invoice finalization, query `getUnsettledEntries(ledgerId, { sourceType: "agent_usage" })` to discover debits from agent billing (future Phase 6)
- Convert unsettled entries into invoiceable items with deterministic linkage
- Mark entries settled with `settlementType: "invoice"` and `settlementId: invoiceId` only after invoice linkage is safely persisted
- No duplicate attachment across retries (use source identity)

Important constraint:
- This step is forward-looking infrastructure. Until Phase 6 posts agent-usage debits, this code path will find zero unsettled entries and be a no-op.

**4.9 — Write unit tests for retry safety, balances, and billing integration**

Add tests for:
- Sequential balances (debit, credit, running balance correctness)
- Idempotent reposting with the same source identity (retry returns existing entry)
- Unsettled balance reads
- Settlement marking (batch, with correct types)
- Auto-creation of missing ledgers
- BillingService posting debits during invoice finalization
- BillingService discovering unsettled entries (mock some agent-usage debits, verify they appear on invoice)

---

## Phase 5: Webhook Pipeline

> **PR title:** `feat: add provider webhook pipeline`
>
> **Goal:** Add provider webhook handling after provider mapping, webhook
> secret storage, and ledger are in place.
>
> **Branch:** `feat/webhook-pipeline`

### Commits

**5.1 — Add generic webhook route skeleton**

Create a generic provider webhook route under `apps/api/src/routes/`.

Requirements:
- parse raw body and headers
- resolve the provider through the existing `PaymentProviderResolver` (which now decrypts webhook secrets via Phase 2)
- verify signatures using stored webhook secrets

**5.2 — Implement idempotent event persistence with `webhook_events`**

For each normalized event:
- insert or load by `(projectId, provider, providerEventId)`
- skip already processed events
- preserve payload and failure context for replay/debugging

**5.3 — Create `processWebhookEvent` use case**

Use a dedicated use case for invoice, ledger, and subscription-machine coordination.

Requirements:
- `payment.succeeded` updates invoice state and settles the right ledger entries via `LedgerService.markSettled()`
- `payment.failed` updates invoice/payment attempt state and reports machine failure via `machine.reportPaymentFailure()`
- dispute/refund paths use reversal-style ledger credits when appropriate

Files to read first:
- [internal/services/src/billing/service.ts#L340](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L340)
- [internal/services/src/subscriptions/machine.ts](/Users/jhonsfran/repos/unprice/internal/services/src/subscriptions/machine.ts) — xstate v5 machine with `reportPaymentSuccess()`, `reportPaymentFailure()`

**5.4 — Implement Stripe webhook parsing**

Add webhook event parsing to the Stripe implementation.

Requirements:
- Verify signatures using the Stripe SDK with the decrypted webhook secret
- Normalize supported Stripe event types to provider-agnostic event types
- Return normalized webhook events to the route/use-case layer

Files to read first:
- [internal/services/src/payment-provider/stripe.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/stripe.ts)

**5.5 — Register the route after parity tests pass**

Wire the route into [apps/api/src/index.ts](/Users/jhonsfran/repos/unprice/apps/api/src/index.ts) only after:
- signature verification works
- idempotency is covered by tests
- success/failure invoice transitions are covered by tests

**5.6 — Write tests for replay safety and ledger reconciliation**

Add tests for:
- duplicate webhook delivery (idempotency)
- successful payment settling ledger entries
- failed payment updating invoice attempts / state transitions
- invalid signatures being rejected
- dispute/refund creating reversal credits

---

## Phase 6: Agent Billing Contract And Runtime Flow

> **PR title:** `feat: add agent billing flow`
>
> **Goal:** Support API-key-backed customer billing with settlement routing.
> This phase extends the API and ingestion contracts, wires agent usage into
> rating and ledger, and introduces the settlement router that was deferred
> from Phase 4.
>
> **Branch:** `feat/agent-billing`

### Commits

**6.1 — Add `apikey_customers` service methods and tRPC mutation**

Implement:
- API key to customer resolution: `resolveCustomerByApiKey(projectId, apikeyId)`
- API key to customer linking: `linkApiKeyToCustomer(projectId, apikeyId, customerId)`

Use the existing tRPC apikey router surface as the first integration point.

Current state: The `apikeys` table has no `customerId` field or FK to customers. The `ApiKeysService` validates keys but has no customer resolution logic. The tRPC router has 4 operations (create, revoke, roll, listByActiveProject) — none involve customer mapping.

Files to read first:
- `internal/trpc/src/router/lambda/apikeys/`
- [internal/services/src/apikey/service.ts](/Users/jhonsfran/repos/unprice/internal/services/src/apikey/service.ts)

**6.2 — Verify manual grants for agent provisioning**

The current `GrantsManager.createGrant()` already supports `type: "manual"`.
This step should verify and test agent provisioning scenarios instead of assuming a subscription dependency that does not currently exist.

Files to read first:
- [internal/services/src/entitlements/grants.ts#L837](/Users/jhonsfran/repos/unprice/internal/services/src/entitlements/grants.ts#L837)

**6.3 — Extend the sync ingestion API contract to support API-key-only resolution**

Before wiring agent billing into ingestion:
- make `customerId` optional in `rawEventSchema` for the sync ingestion route
- when `customerId` is omitted, resolve the customer from `apikey_customers` using the authenticated API key's ID
- update `resolveContextProjectId()` to work without `customerId` (the key already provides `projectId`)

Current state:
- `keyAuth()` provides `ApiKeyExtended` with `projectId` and nested workspace context, but NO customer mapping
- `resolveContextProjectId()` requires `customerId` to detect self-reflection (when `customerId === workspace.unPriceCustomerId`)
- `buildIngestionQueueMessage()` requires `body.customerId`
- Deduplication key is `[projectId, customerId, idempotencyKey]` — this still works once customerId is resolved

Important constraint:
- This is an API contract change, not just an internal service tweak.
- Self-reflection logic must still work when customerId is provided explicitly.

Files to read first:
- [apps/api/src/routes/events/ingestEventsSyncV1.ts](/Users/jhonsfran/repos/unprice/apps/api/src/routes/events/ingestEventsSyncV1.ts) — line 74: `customerId` required
- [apps/api/src/auth/key.ts#L191](/Users/jhonsfran/repos/unprice/apps/api/src/auth/key.ts#L191) — `resolveContextProjectId()`
- [apps/api/src/routes/events/ingestEventsV1.ts#L26](/Users/jhonsfran/repos/unprice/apps/api/src/routes/events/ingestEventsV1.ts#L26)

**6.4 — Extend `EntitlementWindowDO.apply()` to return billing facts**

The DO already computes `delta` and `value_after` and writes them to its analytics outbox. Extend the return type to expose these.

Current return type:
```typescript
{ allowed: boolean, deniedReason?: "LIMIT_EXCEEDED", message?: string }
```

Target return type:
```typescript
{ allowed: boolean, deniedReason?: "LIMIT_EXCEEDED", message?: string,
  delta?: number, valueAfter?: number }
```

This is a ~5-line change — the data is already computed, it just isn't returned. No new interface needed.

Files to read first:
- [apps/api/src/ingestion/EntitlementWindowDO.ts#L121](/Users/jhonsfran/repos/unprice/apps/api/src/ingestion/EntitlementWindowDO.ts#L121) — `apply()` method, outbox writes

**6.5 — Add `reportAgentUsage` use case**

Once the ingestion contract provides billing facts (`delta`, `valueAfter`):
- Rate the incremental usage through `RatingService.rateIncrementalUsage()` using the marginal approach
- Post idempotent ledger debit with `sourceType: "agent_usage"`, `sourceId: eventId`
- Resolve funding strategy (see 6.6)

Important constraint:
- This use case is downstream of the ingestion contract change, not a prerequisite for it.

**6.6 — Add SettlementRouter for funding strategy resolution**

Now that agent billing creates real demand for settlement routing, add the router.

Routing rules:
- `wallet`: immediate internal credit + settlement marking (only if wallet DO infrastructure exists)
- `subscription`: leave entries billable by the subscription invoice flow until consumed by BillingService (Phase 4.8)
- `one_time`: leave entries pending collection until payment succeeds (via webhook in Phase 5)
- `threshold_invoice`: design only, no implementation required

Important constraints:
- Do not implement subscription and one-time settlement as "just mark entries settled".
- Wallet settlement is the only path that can safely post a balancing credit and mark entries settled in one phase, because it is an internal funding source.
- If wallet infrastructure does not exist yet, keep wallet support behind an explicit later dependency.

**6.7 — Wire `reportAgentUsage` into the sync ingestion path**

Only after `customerId` resolution and billing-fact output are both available.

Important constraint:
- Do not insert speculative calls into the ingestion path before the data contract is real.

**6.8 — Add `provisionAgentCustomer` use case**

Coordinate:
- customer creation or lookup
- API key linking via `apikey_customers`
- manual grant creation
- optional wallet top-up, if wallet infrastructure exists by then

**6.9 — Write tests for the full agent-billing path**

Add tests for:
- API key to customer resolution
- provisioning with manual grants
- sync ingestion with API-key-only customer resolution
- `EntitlementWindowDO.apply()` returning `delta` and `valueAfter`
- incremental rating via marginal approach (flat, tiered, package)
- ledger posting after metering facts are available
- settlement routing (subscription leaves entries for billing, wallet settles immediately)
- unsettled agent-usage debits appearing on the next subscription invoice

---

## Phase 7: Trace Aggregation DO (Optional Extension)

> **PR title:** `feat: add trace aggregation durable object`
>
> **Goal:** Aggregate trace-scoped usage events before billing them. This is a
> useful extension, but it is not required to land the pricing, provider,
> ledger, and agent-billing foundations above.
>
> **Branch:** `feat/trace-aggregation`

### Commits

**7.1 — Create TraceAggregationDO skeleton**

Follow the Durable Object and SQLite patterns used by [apps/api/src/ingestion/EntitlementWindowDO.ts](/Users/jhonsfran/repos/unprice/apps/api/src/ingestion/EntitlementWindowDO.ts).

**7.2 — Add trace routing in ingestion**

Requirements:
- detect trace-scoped events
- buffer them under a stable trace key
- complete explicitly or on timeout
- re-emit aggregated results through the normal ingestion path

**7.3 — Add alarm-based timeout and cleanup**

Mirror the existing alarm and self-destruction patterns where appropriate.

**7.4 — Add integration tests**

Add tests for:
- explicit completion
- timeout completion
- multi-feature aggregation
- duplicate event handling

---

## Phase Summary

```
Phase 1: Extract Pricing Orchestration Into RatingService
  Extract the orchestration layer (grant resolution, usage fetching, proration,
  waterfall-input preparation) from BillingService into RatingService. Pure
  pricing math stays in @unprice/db/validators. Add marginal pricing for
  real-time incremental rating.

Phase 2: Provider Mapping Foundation
  Fix stripeCustomerId global uniqueness bug. Add provider/customer mapping,
  API-key/customer mapping, webhook event storage, and webhook-secret support
  with dual-read and dual-write migration rules.

Phase 3: Decouple Provider-Specific Coupling Points
  Fix the four specific coupling points (resolver hardcodes, customer metadata,
  callback routes, provider-specific behavior) rather than adding a new
  abstraction layer on the already-abstract PaymentProviderInterface.

Phase 4: Idempotent Ledger With Billing Consumption
  Add retry-safe ledger storage, deterministic posting, and wire it into
  BillingService so ledger debits become invoiceable items. Merged from
  original Phases 4+5 since settlement routing has no consumer until Phase 6.

Phase 5: Webhook Pipeline
  Add signature verification, event idempotency, invoice transitions, and
  ledger reconciliation.

Phase 6: Agent Billing Contract And Runtime Flow
  Extend the API and ingestion contracts, wire agent usage into rating and
  ledger, and add the settlement router (deferred from Phase 4).

Phase 7: Trace Aggregation DO (Optional Extension)
  Add trace-scoped aggregation after the main billing foundations are stable.
```

## Dependencies and Parallel Tracks

Phases 1+4 and 2+3 can proceed **in parallel** since they touch different parts of the codebase.

```
Track A (pricing + accounting):
  Phase 1 (Rating) → Phase 4 (Ledger + Billing Consumption)

Track B (provider + schema):
  Phase 2 (Schema) → Phase 3 (Provider Decoupling)

Merge point:
  Phase 5 (Webhooks) — needs Phases 2, 3, and 4

Final:
  Phase 6 (Agent Billing + Settlement) — needs Phases 1, 2, 4, and 5

Optional:
  Phase 7 (Trace Aggregation) — needs Phase 6 only if traces are part of agent billing
```

Explicit dependency list:
1. Phase 1 is a prerequisite for safe incremental usage rating (Phase 6).
2. Phase 2 is a prerequisite for Phases 3 and 5.
3. Phase 3 depends on Phase 2.
4. Phase 4 depends on Phase 1 (RatingService must exist before ledger wires into billing).
5. Phase 5 depends on Phases 2, 3, and 4.
6. Phase 6 depends on Phases 1, 2, 4, and 5. Partially on Phase 5 if one-time settlement is provider-backed.
7. Phase 7 depends on Phase 6 only if trace aggregation is part of the agent-billing path.

## Non-Goals For The First Pass

- Removing `customers.stripeCustomerId` in the same PR that introduces provider mappings
- Deleting Stripe callback routes before generic-provider parity exists
- Marking subscription-backed or one-time ledger entries settled before there is a consumer for them
- Creating a second pricing abstraction layer — reuse `calculatePricePerFeature()` from validators
- Creating a "collector" abstraction on top of the already-abstract `PaymentProviderInterface`
- Building wallet DO infrastructure before agent billing creates demand for it
- Moving pure pricing functions out of `@unprice/db/validators/subscriptions/prices.ts`
