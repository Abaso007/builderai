# API scripts: R2 and Pipelines configuration

Scripts to configure R2 Data Catalog, lifecycle rules, and Cloudflare Pipelines for the lakehouse data sources: **verifications**, **usage**, **metadata**, and **entitlements**.
R2 buckets are assumed to already exist.

Reference: [Build an end-to-end data pipeline (Cloudflare)](https://developers.cloudflare.com/r2-sql/tutorials/end-to-end-pipeline/).

## Layout

- **`configure-lakehouse-pipelines.sh`** – Main entry: enables Data Catalog, creates streams/sinks/pipelines for all four sources, optionally applies lifecycle. Does not create buckets.
- **`configure-r2-and-pipelines.sh`** – Deprecated wrapper to `configure-lakehouse-pipelines.sh`.
- **`setup-r2-lifecycle.sh`** – Applies R2 lifecycle rules (raw delete after 7 days, compacted retention, multipart abort) to the chosen env bucket.
- **`r2-lifecycle.json`** – Lifecycle rules used by `setup-r2-lifecycle.sh`.
- **`generate-lakehouse-schemas.ts`** – Regenerates `schemas/*.json` from `@unprice/lakehouse` registry.
- **`schemas/`** – Pipeline stream JSON schemas (these define the **Iceberg table columns**; see [Iceberg schema and partitioning](docs/iceberg-schema-and-partitioning.md)):
  - `usage.json` – Usage events (aligned with `LakehouseUsageEvent`).
  - `verifications.json` – Verification events (aligned with `LakehouseVerificationEvent`).
  - `metadata.json` – Metadata events (aligned with `LakehouseMetadataEvent`).
  - `entitlements.json` – Entitlement snapshot events (aligned with `entitlementSchema` from `internal/db/src/validators/entitlements.ts`).
- **`docs/`** – Extra documentation:
  - **`iceberg-schema-and-partitioning.md`** – How the Apache Iceberg table schema and partition keys are determined (stream schema + `__ingest_ts`, partition by DAY on `__ingest_ts`; custom partition keys like `(event_date, project_id, customer_id)` are not configurable via wrangler for R2 Data Catalog sinks).

All scripts are intended to be run from **`apps/api`** (where `wrangler` and `node_modules` live). You can also use npm from `apps/api`:

- `npm run scripts:r2-lifecycle -- dev` (or `preview` / `prod`)
- `npm run scripts:r2-pipelines -- dev` (options: `--skip-lifecycle`, `--skip-compaction`, `--recreate`, `--delete-only`, `--name-prefix`, `--name-suffix`)
- `npm run scripts:lakehouse-schemas` (regenerates pipeline schema JSON files)

## Regenerate schema JSON files

When fields change in `internal/lakehouse/src/registry.ts`, regenerate Cloudflare stream schema files:

```bash
npm run scripts:lakehouse-schemas
```

This writes:

- `scripts/schemas/usage.json`
- `scripts/schemas/verifications.json`
- `scripts/schemas/metadata.json`
- `scripts/schemas/entitlements.json`

## Prerequisites

1. **Wrangler**
   - From `apps/api`: `npx wrangler login`.

2. **API token for R2 Data Catalog and Pipelines**
   - In [Cloudflare API tokens](https://dash.cloudflare.com/?to=/:account/api-tokens): Create Custom Token with:
     - **Workers Pipelines**: Read, Send, Edit
     - **Workers R2 Data Catalog**: Read, Edit
     - **Workers R2 SQL**: Read (for querying)
     - **Workers R2 Storage**: Read, Edit
   - Export it (preferred variable):
     ```bash
     export WRANGLER_R2_SQL_AUTH_TOKEN="<your-token>"
     ```
   - Optional fallback: `CLOUDFLARE_API_TOKEN` is also accepted by `configure-lakehouse-pipelines.sh` and will be used when `WRANGLER_R2_SQL_AUTH_TOKEN` is unset.

3. **Environments and buckets** (must match `wrangler.jsonc`):
   - `dev` → `unprice-lakehouse-dev`
   - `preview` → `unprice-lakehouse-preview`
   - `prod` → `unprice-lakehouse-prod`
   - Buckets must already exist before running pipeline configuration.

## Usage

### Pipeline configuration (catalog + streams + sinks + pipelines + lifecycle)

From `apps/api`:

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN="<token>"
./scripts/configure-lakehouse-pipelines.sh dev
```

Or:

```bash
export CLOUDFLARE_API_TOKEN="<token>"
./scripts/configure-lakehouse-pipelines.sh dev
```

Use `dev`, `preview`, or `prod` depending on the environment you want to provision.

### Options

- **`--skip-lifecycle`** – Do not apply R2 lifecycle rules.
- **`--skip-compaction`** – Do not enable R2 Data Catalog compaction.
- **`--recreate`** – Delete matching pipelines/sinks/streams first, then recreate.
- **`--delete-only`** – Delete matching pipelines/sinks/streams and exit (no create).
- **`--name-prefix <prefix>`** – Prefix for stream/sink/pipeline names.
- **`--name-suffix <suffix>`** – Suffix for stream/sink/pipeline names (default is `_<environment>`).

Examples:

```bash
# Catalog + pipelines, no lifecycle
./scripts/configure-lakehouse-pipelines.sh dev --skip-lifecycle

# Force clean recreate for one environment naming scheme
./scripts/configure-lakehouse-pipelines.sh dev --recreate

# Delete only (for broken partial setup), then run again without --delete-only
./scripts/configure-lakehouse-pipelines.sh dev --delete-only

# Custom name format (prefix + suffix)
./scripts/configure-lakehouse-pipelines.sh prod --name-prefix "team1_" --name-suffix "_prod"
```

## Local development strategy

- Use this script for cloud-backed validation in `dev`, `preview`, or `prod`.
- Run Workers locally with `wrangler dev` when you only need local API iteration.
- Use cloud environments whenever you need to validate full stream -> sink -> catalog flow.

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
| **Streams** | `${prefix}lakehouse_usage_stream${suffix}`, `${prefix}lakehouse_verifications_stream${suffix}`, `${prefix}lakehouse_metadata_stream${suffix}`, `${prefix}lakehouse_entitlements_stream${suffix}` |
| **Sinks** | `${prefix}lakehouse_usage_sink${suffix}`, `${prefix}lakehouse_verifications_sink${suffix}`, `${prefix}lakehouse_metadata_sink${suffix}`, `${prefix}lakehouse_entitlements_sink${suffix}` |
| **Pipelines** | `${prefix}lakehouse_usage_pipeline${suffix}`, `${prefix}lakehouse_verifications_pipeline${suffix}`, `${prefix}lakehouse_metadata_pipeline${suffix}`, `${prefix}lakehouse_entitlements_pipeline${suffix}` |

Default naming:

- `prefix=""`
- `suffix="_<environment>"` (for example `_preview` or `_prod`)

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

Re-running `configure-lakehouse-pipelines.sh` is safe: existing resources are detected and skipped. For clean replacement, use `--recreate` (or `--delete-only` followed by a normal run).

## Related

- **Wrangler config** – `apps/api/wrangler.jsonc` defines R2 bucket bindings (`LAKEHOUSE`). `preview`/`prod` also define `LAKEHOUSE_PIPELINE_*` bindings that point to stream resources (`lakehouse_<source>_stream_<environment>`). Local `dev` can ingest over HTTP stream endpoints via `LAKEHOUSE_STREAM_*_URL` and `LAKEHOUSE_STREAM_AUTH_TOKEN`.
- **Lakehouse types/registry** – `internal/lakehouse/src/interface.ts` and `internal/lakehouse/src/registry.ts` define the shared event contracts that `scripts/schemas/` align with.
