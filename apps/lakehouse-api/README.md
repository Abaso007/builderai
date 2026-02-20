# Lakehouse API (Fly.io)

This service now runs as a standard FastAPI app on Fly.io (no Cloudflare Worker runtime).

## Local Development

Install `uv` first:
https://docs.astral.sh/uv/getting-started/installation/#standalone-installer

From `apps/lakehouse-api`:

```bash
cp .env.local.example .env.local
pnpm setup
pnpm dev
```

This starts the API on `http://localhost:4000` and automatically loads local env files:

1. `.env.local`
2. `.env`

`.env.local.example` contains a ready-to-use template with dev defaults.

## Deploy to Fly.io

Install Fly CLI and authenticate:
https://fly.io/docs/flyctl/install/

From `apps/lakehouse-api`:

```bash
fly auth login
fly apps create unprice-lakehouse-api-dev
fly secrets set \
  LAKEHOUSE_API_TOKEN=... \
  CATALOG_TOKEN=... \
  CLOUDFLARE_API_TOKEN_LAKEHOUSE=... \
  CLOUDFLARE_ACCOUNT_ID=... \
  CLOUDFLARE_LAKEHOUSE_ACCESS_KEY_ID=...
pnpm deploy
```

`fly.toml` is configured for a dev-only app (`unprice-lakehouse-api-dev`) and sets:

- `ENV=dev`
- `CATALOG=unprice-lakehouse-dev`
- `CATALOG_NAMESPACE=lakehouse`
- `LAKEHOUSE_BUCKET_NAME=unprice-lakehouse-dev`

## Environment Variables

Required secrets:

- `LAKEHOUSE_API_TOKEN`: Bearer token required by `POST /v1/lakehouse/files`
- `CATALOG_TOKEN`: Cloudflare R2 Data Catalog token
- `CLOUDFLARE_API_TOKEN_LAKEHOUSE`: Cloudflare API token with R2 temp credential permissions
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account id
- `CLOUDFLARE_LAKEHOUSE_ACCESS_KEY_ID`: parent R2 access key id used for temp credentials

Required non-secret vars:

- `CATALOG`: e.g. `unprice-lakehouse-dev`
- `CATALOG_NAMESPACE`: e.g. `lakehouse`
- `LAKEHOUSE_BUCKET_NAME`: R2 bucket name (defaults to `CATALOG` if omitted)
- `ENV`: use `dev` for development environments (enables FastAPI docs)
- `LAKEHOUSE_RESPONSE_CACHE_SWR_SECONDS` (optional): fresh window for SWR in seconds. Default `300` (5 min), max `3540`.
- `LAKEHOUSE_RESPONSE_CACHE_STALE_SECONDS` (optional): maximum stale window in seconds. Default `3300` (55 min), max `3540`.
- `LAKEHOUSE_RESPONSE_CACHE_MAX_ENTRIES` (optional): max in-memory cache entries. Default `512`.

## Endpoint

`POST /v1/lakehouse/files`

Request body:

```json
{
  "project_id": ["proj_11STWG6AokEni2F3eQugHb"],
  "customer_id": ["cus_11TqNF6bCebUjnx55pk6vs"],
  "tables": ["verification", "usage"],
  "interval": "7d"
}
```

Notes:

- Only `project_id` and `interval` are required.
- `project_id` accepts a string or an array (at least one project id).
- `customer_id` is optional and accepts `null`, empty string, empty array, a single string, or an array of strings.
- `tables` is optional and accepts a string or an array. If omitted/empty, all allowed tables are used.
- Allowed table names: `usage`, `verification`, `metadata`, `entitlement_snapshot`.
- `interval` is required and supports only `1d`, `7d`, `30d`, `90d`.
- Query window is always `now() - interval` to `now()` (UTC).
- Response includes `credentials` (temporary R2 access keys) plus `urls` (unsigned catalog-derived `s3://...` paths).
- Temporary credential TTL is fixed to 1 hour.
- Requests with the same effective parameters use SWR in-memory cache (`X-Lakehouse-Cache: MISS|HIT|STALE`).
- Default behavior: fresh cache for 5 min, then serve stale and refresh in background, with max stale 55 min.
- Table names are always normalized to `{CATALOG_NAMESPACE}.{table}`.
- FastAPI docs endpoints (`/docs`, `/openapi.json`, `/redoc`) are available only when `ENV` is `dev`, `development`, or `local`.
- In docs (`/docs`), click `Authorize` and paste `LAKEHOUSE_API_TOKEN` as Bearer token to test the endpoint.

## Quick Test (curl)

Minimal payload (required fields only):

```bash
curl -i -sS -X POST "http://localhost:4000/v1/lakehouse/files" \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": ["proj_11STWG6AokEni2F3eQugHb"],
    "interval": "7d"
  }'
```

Run the same command twice to verify cache behavior:

- First call: `X-Lakehouse-Cache: MISS`
- Second call (within 5 minutes): `X-Lakehouse-Cache: HIT`
- First call after fresh window: `X-Lakehouse-Cache: STALE` (background refresh starts)

`customer_id` examples that are all valid:

```json
{ "customer_id": null }
{ "customer_id": "" }
{ "customer_id": [] }
{ "customer_id": ["cus_a", "cus_b"] }
```
