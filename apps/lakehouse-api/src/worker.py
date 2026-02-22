import os
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from threading import Lock, Thread
from time import monotonic
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response, Security
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
    _issue_temp_credentials,
    _utc_iso,
)


# Localhost development env file support.
load_dotenv(".env.local", override=False)
load_dotenv(".env", override=False)

app = FastAPI()
bearer_scheme = HTTPBearer(auto_error=False)

CATALOG_NAMESPACE = "lakehouse"
TARGET_ENV_CATALOG_NAME = {
    "non_prod": "unprice-lakehouse-dev",
    "prod": "unprice-lakehouse-prod",
}

DEFAULT_RESPONSE_CACHE_SWR_SECONDS = 60
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


def _require_env_any(env: Any, keys: list[str]) -> str:
    for key in keys:
        value = _get_env_value(env, key)
        if value is not None and value.strip():
            return value.strip()
    raise HTTPException(status_code=500, detail=f"Missing required environment variable: {' or '.join(keys)}")


def _resolve_target_env_config(env: Any, *, target_env: str) -> dict[str, str]:
    prefix = target_env.upper()
    catalog_name = TARGET_ENV_CATALOG_NAME[target_env]
    return {
        "target_env": target_env,
        "account_id": _require_env_any(env, [f"{prefix}_CLOUDFLARE_ACCOUNT_ID"]),
        "catalog_name": catalog_name,
        "namespace": CATALOG_NAMESPACE,
        "bucket_name": catalog_name,
        "auth_api_token": _require_env_any(
            env,
            [
                f"{prefix}_LAKEHOUSE_API_TOKEN",
                f"{prefix}_AUTH_API_TOKEN",
            ],
        ),
        "catalog_token": _require_env_any(env, [f"{prefix}_CATALOG_TOKEN"]),
        "credential_api_token": _require_env_any(env, [f"{prefix}_CLOUDFLARE_API_TOKEN_LAKEHOUSE"]),
        "parent_access_key_id": _require_env_any(env, [f"{prefix}_CLOUDFLARE_LAKEHOUSE_ACCESS_KEY_ID"]),
    }


def _require_bearer_token(*, credentials: HTTPAuthorizationCredentials | None, expected_token: str) -> None:
    provided_token = credentials.credentials if credentials and credentials.scheme.lower() == "bearer" else None
    if provided_token != expected_token:
        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Bearer"},
        )


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


def _normalize_urls(urls: Any) -> list[str]:
    if not isinstance(urls, list):
        return []
    return sorted(_dedupe([item for item in urls if isinstance(item, str) and item]))


def _credentials_from_response(response_payload: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(response_payload, dict):
        return None
    credentials = response_payload.get("credentials")
    return credentials if isinstance(credentials, dict) else None


def _parse_utc_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None

    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"

    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _credentials_expired(credentials: dict[str, Any] | None) -> bool:
    if not credentials:
        return True
    expiration_dt = _parse_utc_iso(credentials.get("expiration"))
    if expiration_dt is None:
        return True
    return expiration_dt <= datetime.now(timezone.utc)


def _cache_stale_until_monotonic(
    *,
    response_payload: dict[str, Any],
    now_monotonic: float,
    stale_seconds: int,
) -> float:
    stale_until = now_monotonic + stale_seconds
    credentials = _credentials_from_response(response_payload)
    if not credentials:
        return stale_until

    expiration_dt = _parse_utc_iso(credentials.get("expiration"))
    if expiration_dt is None:
        return stale_until

    seconds_until_expiration = (expiration_dt - datetime.now(timezone.utc)).total_seconds()
    credential_expiration_monotonic = now_monotonic + max(0.0, seconds_until_expiration)
    return min(stale_until, credential_expiration_monotonic)


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
    previous_response: dict[str, Any] | None = None,
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
    table_files: dict[str, list[str]] = {table_name: [] for table_name in payload.tables}
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

        table_files[table_name] = table_urls
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

    previous_urls = _normalize_urls(previous_response.get("urls") if previous_response else None)
    current_urls = _normalize_urls(urls)
    previous_credentials = _credentials_from_response(previous_response)
    urls_changed = previous_urls != current_urls
    should_issue_credentials = urls_changed or _credentials_expired(previous_credentials)

    credentials_payload: dict[str, Any]
    if should_issue_credentials:
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

        credentials_payload = {
            "bucket": bucket_name,
            "r2_endpoint": f"https://{account_id}.r2.cloudflarestorage.com",
            "access_key_id": credentials["access_key_id"],
            "secret_access_key": credentials["secret_access_key"],
            "session_token": credentials["session_token"],
            "expiration": credentials["expiration"],
            "ttl_seconds": credentials["ttl_seconds"],
            "prefixes": credentials["prefixes"],
        }
    else:
        credentials_payload = deepcopy(previous_credentials)

    return {
        "project_ids": payload.project_ids,
        "customer_ids": payload.customer_ids,
        "interval": payload.interval,
        "interval_days": interval_days,
        "window": {
            "start": _utc_iso(start_dt),
            "end": _utc_iso(end_dt),
        },
        "credentials": credentials_payload,
        "table_files": table_files,
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
    target_env: str,
    account_id: str,
    catalog_name: str,
    namespace: str,
    bucket_name: str,
    payload: FilePlanRequest,
) -> str:
    key_payload = {
        "target_env": target_env,
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
    stale_until_monotonic = _cache_stale_until_monotonic(
        response_payload=response_payload,
        now_monotonic=now_monotonic,
        stale_seconds=stale_seconds,
    )
    with _response_cache_lock:
        _prune_response_cache(now_monotonic=now_monotonic, max_entries=max_entries)
        _response_cache[cache_key] = (
            now_monotonic + swr_seconds,
            stale_until_monotonic,
            deepcopy(response_payload),
        )
        _prune_response_cache(now_monotonic=now_monotonic, max_entries=max_entries)


@app.middleware("http")
async def docs_only_in_development(req: Request, call_next):
    return await call_next(req)


@app.get("/")
async def root():
    return {"status": "ok", "service": "lakehouse-api"}


@app.post("/v1/lakehouse/files")
async def get_matching_files(
    req: Request,
    payload: FilePlanRequest,
    response: Response,
    credentials: HTTPAuthorizationCredentials | None = Security(bearer_scheme),
):
    env = _runtime_env(req)
    target_config = _resolve_target_env_config(env, target_env=payload.target_env)

    _require_bearer_token(credentials=credentials, expected_token=target_config["auth_api_token"])

    account_id = target_config["account_id"]
    catalog_name = target_config["catalog_name"]
    namespace = target_config["namespace"]
    catalog_token = target_config["catalog_token"]
    credential_api_token = target_config["credential_api_token"]
    parent_access_key_id = target_config["parent_access_key_id"]
    bucket_name = target_config["bucket_name"]
    cache_swr_seconds = _response_cache_swr_seconds(env)
    cache_stale_seconds = _response_cache_stale_seconds(env, min_value=cache_swr_seconds)
    cache_max_entries = _response_cache_max_entries(env)

    cache_key = _build_response_cache_key(
        target_env=payload.target_env,
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
            refresh_previous_response = deepcopy(cached_response)

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
                    previous_response=refresh_previous_response,
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
