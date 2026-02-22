# Analytics (Tinybird)

This package contains Tinybird datasources, pipes, endpoints, fixtures, and tests for billing and product analytics.

## Current Architecture

- Source of truth: R2 raw lakehouse files.
- Tinybird role: billing and operational analytics.
- Durable Object flush writes to both Tinybird and R2.
- Buffered rows are deleted only after both sinks are confirmed.

## V2 Schema Direction

The current direction optimizes Tinybird cost and query latency:

- Billing usage dedup no longer relies on `FINAL` in endpoint SQL.
- Verification regions are queried from materialized views.
- Tinybird metadata ingestion from DO flush is disabled.
- Raw usage and verification datasources keep only billing/analytics-essential columns.
- Raw datasources have retention TTLs to limit storage cost.

## Tinybird Resources

- Datasources: `internal/analytics/datasources/*.datasource`
- Materialized destinations: `internal/analytics/materializations/*.datasource`
- Materialization pipes: `internal/analytics/pipes/*.pipe`
- Endpoints: `internal/analytics/endpoints/*.pipe`
- Fixtures: `internal/analytics/fixtures/*`
- Tests: `internal/analytics/tests/*.yaml`

## How To Test

Tinybird CI already runs:

- `tb build`
- `tb test run`

See `.github/workflows/job_tinybird_ci.yml`.

Local flow:

```bash
cd internal/analytics
tb build
tb test run
```

Add a new endpoint test:

```bash
cd internal/analytics
tb test create endpoints/<pipe_name>.pipe
```

Then edit `tests/<pipe_name>.yaml` and validate expected output.

## Migration and Verification Runbook

Before deploy:

```bash
cd internal/analytics
tb build
tb test run
tb deploy --check
```

Deploy uses cloud host/token in CI (`.github/workflows/job_tinybird_cd.yml`).

For incompatible schema changes:

- Add `FORWARD_QUERY` in datasource definitions.
- Use explicit defaults for removed columns.
- Deploy readers and endpoint changes first, then writers.

For this project, follow the detailed metering evolution guide:

- `apps/docs/concepts/pricing/schema-evolution.mdx`

## Important Validations After Schema Changes

1. Billing dedup parity
- Validate `v1_get_feature_usage_no_duplicates` output for duplicate keys, latest version wins, and soft-delete cases.

2. Verification regions correctness
- Validate `v1_get_feature_verification_regions` output against known fixture rows.

3. Storage controls
- Confirm raw datasource TTLs in:
  - `internal/analytics/datasources/unprice_feature_usage_records.datasource`
  - `internal/analytics/datasources/unprice_feature_verifications.datasource`
  - `internal/analytics/datasources/unprice_feature_metadata.datasource`

4. Runtime safety
- Confirm ingestion success/quarantine logs and endpoint responses during rollout.

## Notes

- Keep R2 as full-fidelity archive for deep analytics and reprocessing.
- Keep Tinybird lean: only columns needed for billing and operational dashboards.
