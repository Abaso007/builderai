import os
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from threading import Lock, Thread
from time import monotonic
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response, Security
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

try:
    from dotenv import load_dotenv
except Exception:
    def load_dotenv(*_args, **_kwargs):
        return False

from src.lakehouse_utils import (
    DEFAULT_CREDENTIAL_TTL_SECONDS,
    FilePlanRequest,
    INTERVAL_ALIASES,
    _build_row_filter,
    _create_catalog,
    _dedupe,
    _extract_files_from_scan,
    _get_env_value,
    _is_development_env,
    _issue_temp_credentials,
    _require_env,
    _utc_iso,
)


# Localhost development env file support.
load_dotenv(".env.local", override=False)
load_dotenv(".env", override=False)

app = FastAPI()
bearer_scheme = HTTPBearer(auto_error=False)

DEFAULT_RESPONSE_CACHE_SWR_SECONDS = 300
MIN_RESPONSE_CACHE_SWR_SECONDS = 30
MAX_RESPONSE_CACHE_SWR_SECONDS = max(MIN_RESPONSE_CACHE_SWR_SECONDS, DEFAULT_CREDENTIAL_TTL_SECONDS - 60)

DEFAULT_RESPONSE_CACHE_STALE_SECONDS = 3300
MIN_RESPONSE_CACHE_STALE_SECONDS = MIN_RESPONSE_CACHE_SWR_SECONDS
MAX_RESPONSE_CACHE_STALE_SECONDS = max(MIN_RESPONSE_CACHE_STALE_SECONDS, DEFAULT_CREDENTIAL_TTL_SECONDS - 60)

DEFAULT_RESPONSE_CACHE_MAX_ENTRIES = 512
MIN_RESPONSE_CACHE_MAX_ENTRIES = 1
MAX_RESPONSE_CACHE_MAX_ENTRIES = 5000

_response_cache_lock = Lock()
_response_cache: dict[str, tuple[float, float, dict[str, Any]]] = {}
_response_cache_refreshing: set[str] = set()


def _runtime_env(req: Request):
    scope_env = req.scope.get("env")
    return scope_env if scope_env is not None else os.environ


def _parse_int_env(
    env: Any,
    *,
    key: str,
    default: int,
    min_value: int,
    max_value: int,
) -> int:
    raw = _get_env_value(env, key)
    try:
        parsed = int(raw) if raw is not None else default
    except (TypeError, ValueError):
        parsed = default
    return max(min_value, min(parsed, max_value))


def _response_cache_swr_seconds(env: Any) -> int:
    return _parse_int_env(
        env,
        key="LAKEHOUSE_RESPONSE_CACHE_SWR_SECONDS",
        default=DEFAULT_RESPONSE_CACHE_SWR_SECONDS,
        min_value=MIN_RESPONSE_CACHE_SWR_SECONDS,
        max_value=MAX_RESPONSE_CACHE_SWR_SECONDS,
    )


def _response_cache_stale_seconds(env: Any, *, min_value: int) -> int:
    raw_stale = _get_env_value(env, "LAKEHOUSE_RESPONSE_CACHE_STALE_SECONDS")
    if raw_stale is None:
        # Backwards-compatible fallback for older config.
        raw_stale = _get_env_value(env, "LAKEHOUSE_RESPONSE_CACHE_TTL_SECONDS")

    try:
        parsed = int(raw_stale) if raw_stale is not None else DEFAULT_RESPONSE_CACHE_STALE_SECONDS
    except (TypeError, ValueError):
        parsed = DEFAULT_RESPONSE_CACHE_STALE_SECONDS

    return max(min_value, min(parsed, MAX_RESPONSE_CACHE_STALE_SECONDS))


def _cache_entry_state(*, now_monotonic: float, fresh_until: float, stale_until: float) -> str:
    if stale_until <= now_monotonic:
        return "EXPIRED"
    if fresh_until > now_monotonic:
        return "FRESH"
    return "STALE"


def _start_background_refresh_if_needed(*, cache_key: str) -> bool:
    with _response_cache_lock:
        if cache_key in _response_cache_refreshing:
            return False
        _response_cache_refreshing.add(cache_key)
        return True


def _finish_background_refresh(*, cache_key: str) -> None:
    with _response_cache_lock:
        _response_cache_refreshing.discard(cache_key)


def _spawn_background_refresh(
    *,
    cache_key: str,
    cache_swr_seconds: int,
    cache_stale_seconds: int,
    cache_max_entries: int,
    refresh_fn,
) -> None:
    if not _start_background_refresh_if_needed(cache_key=cache_key):
        return

    def _run_refresh() -> None:
        try:
            response_payload = refresh_fn()
            _set_cached_response(
                cache_key=cache_key,
                response_payload=response_payload,
                swr_seconds=cache_swr_seconds,
                stale_seconds=cache_stale_seconds,
                max_entries=cache_max_entries,
            )
        finally:
            _finish_background_refresh(cache_key=cache_key)

    Thread(target=_run_refresh, daemon=True).start()


def _build_lakehouse_files_response(
    *,
    account_id: str,
    catalog_name: str,
    namespace: str,
    catalog_token: str,
    credential_api_token: str,
    parent_access_key_id: str,
    bucket_name: str,
    payload: FilePlanRequest,
) -> dict[str, Any]:
    warehouse = f"{account_id}_{catalog_name}"

    end_dt = datetime.now(timezone.utc)
    if end_dt.tzinfo is None:
        end_dt = end_dt.replace(tzinfo=timezone.utc)
    else:
        end_dt = end_dt.astimezone(timezone.utc)

    interval_days = INTERVAL_ALIASES[payload.interval]
    start_dt = end_dt - timedelta(days=interval_days)

    try:
        catalog = _create_catalog(
            account_id=account_id,
            catalog_name=catalog_name,
            warehouse=warehouse,
            catalog_token=catalog_token,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to initialize Iceberg catalog: {exc}") from exc

    row_filter = _build_row_filter(
        start_dt=start_dt,
        end_dt=end_dt,
        project_ids=payload.project_ids,
        customer_ids=payload.customer_ids,
    )

    urls: list[str] = []
    all_prefixes: list[str] = []
    errors: list[dict[str, str]] = []

    for table_name in payload.tables:
        table_identifier = f"{namespace}.{table_name}"
        try:
            table = catalog.load_table(table_identifier)
            table.refresh()
            scan = table.scan(row_filter=row_filter)
            table_urls, table_prefixes = _extract_files_from_scan(scan=scan, bucket=bucket_name)
        except Exception as exc:
            errors.append({"table": table_identifier, "error": f"scan_error: {exc}"})
            continue

        urls.extend(table_urls)
        all_prefixes.extend(table_prefixes)

    if not urls and errors:
        raise HTTPException(status_code=404, detail={"message": "No tables could be resolved", "errors": errors})

    urls = _dedupe(urls)
    all_prefixes = _dedupe(all_prefixes)

    if not urls:
        raise HTTPException(
            status_code=404,
            detail={
                "message": "No matching files were found for the requested filters",
                "errors": errors,
            },
        )

    try:
        credentials = _issue_temp_credentials(
            account_id=account_id,
            api_token=credential_api_token,
            bucket=bucket_name,
            parent_access_key_id=parent_access_key_id,
            ttl_seconds=DEFAULT_CREDENTIAL_TTL_SECONDS,
            prefixes=all_prefixes,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to issue temporary credentials: {exc}") from exc

    return {
        "project_ids": payload.project_ids,
        "customer_ids": payload.customer_ids,
        "interval": payload.interval,
        "interval_days": interval_days,
        "window": {
            "start": _utc_iso(start_dt),
            "end": _utc_iso(end_dt),
        },
        "credentials": {
            "bucket": bucket_name,
            "r2_endpoint": f"https://{account_id}.r2.cloudflarestorage.com",
            "access_key_id": credentials["access_key_id"],
            "secret_access_key": credentials["secret_access_key"],
            "session_token": credentials["session_token"],
            "expiration": credentials["expiration"],
            "ttl_seconds": credentials["ttl_seconds"],
            "prefixes": credentials["prefixes"],
        },
        "urls": urls,
        "errors": errors,
    }


def _response_cache_max_entries(env: Any) -> int:
    return _parse_int_env(
        env,
        key="LAKEHOUSE_RESPONSE_CACHE_MAX_ENTRIES",
        default=DEFAULT_RESPONSE_CACHE_MAX_ENTRIES,
        min_value=MIN_RESPONSE_CACHE_MAX_ENTRIES,
        max_value=MAX_RESPONSE_CACHE_MAX_ENTRIES,
    )


def _build_response_cache_key(
    *,
    account_id: str,
    catalog_name: str,
    namespace: str,
    bucket_name: str,
    payload: FilePlanRequest,
) -> str:
    key_payload = {
        "account_id": account_id,
        "catalog_name": catalog_name,
        "namespace": namespace,
        "bucket_name": bucket_name,
        "project_ids": sorted(payload.project_ids),
        "customer_ids": sorted(payload.customer_ids) if payload.customer_ids else None,
        "tables": sorted(payload.tables),
        "interval": payload.interval,
    }
    raw = json.dumps(key_payload, separators=(",", ":"), sort_keys=True)
    return sha256(raw.encode("utf-8")).hexdigest()


def _prune_response_cache(*, now_monotonic: float, max_entries: int) -> None:
    expired_keys: list[str] = [
        key for key, (_, stale_until, _) in _response_cache.items() if stale_until <= now_monotonic
    ]
    for key in expired_keys:
        _response_cache.pop(key, None)

    while len(_response_cache) > max_entries:
        oldest_key = next(iter(_response_cache), None)
        if oldest_key is None:
            break
        _response_cache.pop(oldest_key, None)


def _get_cached_response(cache_key: str) -> tuple[dict[str, Any] | None, str]:
    now_monotonic = monotonic()
    with _response_cache_lock:
        entry = _response_cache.get(cache_key)
        if entry is None:
            return None, "MISS"

        fresh_until, stale_until, response_payload = entry
        state = _cache_entry_state(now_monotonic=now_monotonic, fresh_until=fresh_until, stale_until=stale_until)
        if state == "EXPIRED":
            _response_cache.pop(cache_key, None)
            return None, "MISS"

        return deepcopy(response_payload), ("HIT" if state == "FRESH" else "STALE")


def _set_cached_response(
    *,
    cache_key: str,
    response_payload: dict[str, Any],
    swr_seconds: int,
    stale_seconds: int,
    max_entries: int,
) -> None:
    now_monotonic = monotonic()
    with _response_cache_lock:
        _prune_response_cache(now_monotonic=now_monotonic, max_entries=max_entries)
        _response_cache[cache_key] = (
            now_monotonic + swr_seconds,
            now_monotonic + stale_seconds,
            deepcopy(response_payload),
        )
        _prune_response_cache(now_monotonic=now_monotonic, max_entries=max_entries)


def _require_api_token(req: Request, credentials: HTTPAuthorizationCredentials | None = Security(bearer_scheme)):
    env = _runtime_env(req)
    expected_token = _require_env(env, "LAKEHOUSE_API_TOKEN")
    provided_token = credentials.credentials if credentials and credentials.scheme.lower() == "bearer" else None

    if provided_token != expected_token:
        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Bearer"},
        )


@app.middleware("http")
async def docs_only_in_development(req: Request, call_next):
    is_local_host = (req.url.hostname or "").lower() in {"localhost", "127.0.0.1", "::1"}
    if req.url.path in {"/docs", "/openapi.json", "/redoc"} and not (
        _is_development_env(_runtime_env(req)) or is_local_host
    ):
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    return await call_next(req)


@app.get("/")
async def root():
    return {"status": "ok", "service": "lakehouse-api"}


@app.post("/v1/lakehouse/files")
async def get_matching_files(
    req: Request,
    payload: FilePlanRequest,
    response: Response,
    _token: None = Security(_require_api_token),
):
    env = _runtime_env(req)

    account_id = _require_env(env, "CLOUDFLARE_ACCOUNT_ID")
    catalog_name = _require_env(env, "CATALOG")
    namespace = _require_env(env, "CATALOG_NAMESPACE")
    catalog_token = _require_env(env, "CATALOG_TOKEN")

    # Same credential flow as apps/api/src/lakehouse/service.ts::issueLakehouseCatalogCredentials
    credential_api_token = _require_env(env, "CLOUDFLARE_API_TOKEN_LAKEHOUSE")
    parent_access_key_id = _require_env(env, "CLOUDFLARE_LAKEHOUSE_ACCESS_KEY_ID")
    bucket_name = _get_env_value(env, "LAKEHOUSE_BUCKET_NAME", catalog_name) or catalog_name
    cache_swr_seconds = _response_cache_swr_seconds(env)
    cache_stale_seconds = _response_cache_stale_seconds(env, min_value=cache_swr_seconds)
    cache_max_entries = _response_cache_max_entries(env)

    cache_key = _build_response_cache_key(
        account_id=account_id,
        catalog_name=catalog_name,
        namespace=namespace,
        bucket_name=bucket_name,
        payload=payload,
    )
    cached_response, cache_state = _get_cached_response(cache_key)
    if cached_response is not None:
        response.headers["X-Lakehouse-Cache"] = cache_state

        if cache_state == "STALE":
            refresh_payload = payload.model_copy(deep=True)

            def _refresh_fn():
                return _build_lakehouse_files_response(
                    account_id=account_id,
                    catalog_name=catalog_name,
                    namespace=namespace,
                    catalog_token=catalog_token,
                    credential_api_token=credential_api_token,
                    parent_access_key_id=parent_access_key_id,
                    bucket_name=bucket_name,
                    payload=refresh_payload,
                )

            _spawn_background_refresh(
                cache_key=cache_key,
                cache_swr_seconds=cache_swr_seconds,
                cache_stale_seconds=cache_stale_seconds,
                cache_max_entries=cache_max_entries,
                refresh_fn=_refresh_fn,
            )

        return cached_response

    response.headers["X-Lakehouse-Cache"] = "MISS"

    response_payload = _build_lakehouse_files_response(
        account_id=account_id,
        catalog_name=catalog_name,
        namespace=namespace,
        catalog_token=catalog_token,
        credential_api_token=credential_api_token,
        parent_access_key_id=parent_access_key_id,
        bucket_name=bucket_name,
        payload=payload,
    )
    _set_cached_response(
        cache_key=cache_key,
        response_payload=response_payload,
        swr_seconds=cache_swr_seconds,
        stale_seconds=cache_stale_seconds,
        max_entries=cache_max_entries,
    )
    return response_payload
