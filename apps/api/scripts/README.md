# API scripts: R2 and Pipelines configuration

Scripts to configure R2 buckets, R2 Data Catalog, lifecycle rules, and Cloudflare Pipelines for the lakehouse data sources: **verifications**, **usage**, **metadata**, and **entitlements**.

Reference: [Build an end-to-end data pipeline (Cloudflare)](https://developers.cloudflare.com/r2-sql/tutorials/end-to-end-pipeline/).

## Layout

- **`configure-r2-and-pipelines.sh`** – Main entry: creates buckets (optional), enables Data Catalog, creates streams/sinks/pipelines for all four sources, optionally applies lifecycle.
- **`setup-r2-lifecycle.sh`** – Applies R2 lifecycle rules (raw delete after 7 days, compacted retention, multipart abort) to the chosen env bucket.
- **`r2-lifecycle.json`** – Lifecycle rules used by `setup-r2-lifecycle.sh`.
- **`schemas/`** – Pipeline stream JSON schemas (these define the **Iceberg table columns**; see [Iceberg schema and partitioning](docs/iceberg-schema-and-partitioning.md)):
  - `usage.json` – Usage events (aligned with `LakehouseUsageEvent`).
  - `verifications.json` – Verification events (aligned with `LakehouseVerificationEvent`).
  - `metadata.json` – Metadata events (aligned with `LakehouseMetadataEvent`).
  - `entitlements.json` – Entitlement snapshot events (aligned with `entitlementSchema` from `internal/db/src/validators/entitlements.ts`).
- **`docs/`** – Extra documentation:
  - **`iceberg-schema-and-partitioning.md`** – How the Apache Iceberg table schema and partition keys are determined (stream schema + `__ingest_ts`, partition by DAY on `__ingest_ts`; custom partition keys like `(event_date, project_id, customer_id)` are not configurable via wrangler for R2 Data Catalog sinks).

All scripts are intended to be run from **`apps/api`** (where `wrangler` and `node_modules` live). You can also use npm from `apps/api`:

- `npm run scripts:r2-lifecycle -- dev` (or `preview` / `prod`)
- `npm run scripts:r2-pipelines -- dev` (options: `--skip-buckets`, `--skip-lifecycle`, `--skip-compaction`)

## Prerequisites

1. **Wrangler**
   - From `apps/api`: `npx wrangler login`.

2. **API token for R2 Data Catalog and Pipelines**
   - In [Cloudflare API tokens](https://dash.cloudflare.com/?to=/:account/api-tokens): Create Custom Token with:
     - **Workers Pipelines**: Read, Send, Edit
     - **Workers R2 Data Catalog**: Read, Edit
     - **Workers R2 SQL**: Read (for querying)
     - **Workers R2 Storage**: Read, Edit
   - Export it:
     ```bash
     export WRANGLER_R2_SQL_AUTH_TOKEN="<your-token>"
     ```

3. **Environments and buckets** (must match `wrangler.jsonc`):
   - `dev` → `unprice-lakehouse-dev`
   - `preview` → `unprice-lakehouse-preview`
   - `prod` → `unprice-lakehouse-prod`

## Usage

### Full configuration (buckets + catalog + streams + sinks + pipelines + lifecycle)

From `apps/api`:

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN="<token>"
./scripts/configure-r2-and-pipelines.sh dev
```

For preview/prod, replace `dev` with `preview` or `prod`.

### Options

- **`--skip-buckets`** – Do not create the R2 bucket (use existing bucket from your wrangler env).
- **`--skip-lifecycle`** – Do not apply R2 lifecycle rules.
- **`--skip-compaction`** – Do not enable R2 Data Catalog compaction.

Examples:

```bash
# Only catalog + pipelines + lifecycle (bucket already exists)
./scripts/configure-r2-and-pipelines.sh prod --skip-buckets

# Catalog + pipelines, no lifecycle
./scripts/configure-r2-and-pipelines.sh dev --skip-lifecycle
```

### Lifecycle only

To apply or re-apply lifecycle rules without touching pipelines:

```bash
./scripts/setup-r2-lifecycle.sh dev   # or preview | prod
```

Lifecycle rules (see `r2-lifecycle.json`):

- **`lakehouse/raw/`** – Delete objects after 7 days.
- **`lakehouse/compacted/`** – Delete after 1 year.
- **All prefixes** – Abort incomplete multipart uploads after 7 days.

## What gets created

| Resource type | Names |
|--------------|--------|
| **Streams** | `lakehouse_usage_stream`, `lakehouse_verifications_stream`, `lakehouse_metadata_stream`, `lakehouse_entitlements_stream` |
| **Sinks** | `lakehouse_usage_sink`, `lakehouse_verifications_sink`, `lakehouse_metadata_sink`, `lakehouse_entitlements_sink` |
| **Pipelines** | `lakehouse_usage_pipeline`, `lakehouse_verifications_pipeline`, `lakehouse_metadata_pipeline`, `lakehouse_entitlements_pipeline` |

Data catalog namespace: **`lakehouse`**. Tables: **`usage`**, **`verification`**, **`metadata`**, **`entitlement_snapshot`**.

- **Iceberg schema**: Table columns = stream schema (from `schemas/*.json`) + **`__ingest_ts`** (added by Pipelines). There is no separate Iceberg schema file; the sink creates the table from the pipeline output.
- **Partitioning**: R2 Data Catalog sinks partition by **DAY on `__ingest_ts`** only. This is fixed and not configurable in wrangler. See [docs/iceberg-schema-and-partitioning.md](docs/iceberg-schema-and-partitioning.md) for details and the desired `(event_date, project_id, customer_id)` spec from the internal design.
- Roll interval for sinks is **60 seconds** (configurable in the script).

## After configuration

1. **Ingest endpoints**  
   List streams to get HTTP ingest URLs and stream IDs:
   ```bash
   npx wrangler pipelines streams list
   ```

2. **R2 SQL**  
   Warehouse name is typically `<ACCOUNT_ID>_<BUCKET_NAME>` (shown when enabling catalog). Query example:
   ```bash
   export WAREHOUSE="<ACCOUNT_ID>_unprice-lakehouse-dev"
   npx wrangler r2 sql query "$WAREHOUSE" "SELECT * FROM lakehouse.usage LIMIT 10"
   ```

3. **Sending events**  
   POST JSON events to the stream HTTP endpoint with header:
   `Authorization: Bearer $WRANGLER_R2_SQL_AUTH_TOKEN`.

## Idempotency

Re-running `configure-r2-and-pipelines.sh` is safe: create steps are best-effort; if a resource already exists, the script logs and continues. To recreate a stream/sink/pipeline, delete it in the dashboard or via wrangler, then run the script again.

## Related

- **Wrangler config** – `apps/api/wrangler.jsonc` defines R2 bucket bindings (`LAKEHOUSE`) per env.
- **Lakehouse types/registry** – `internal/lakehouse/src/interface.ts` and `internal/lakehouse/src/registry.ts` define the shared event contracts that `scripts/schemas/` align with.
