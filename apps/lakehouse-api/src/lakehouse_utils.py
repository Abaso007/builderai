from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

import requests
from fastapi import HTTPException
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator
from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.expressions import And, EqualTo, GreaterThanOrEqual, In, LessThanOrEqual


INTERVAL_ALIASES = {
    "1d": 1,
    "7d": 7,
    "30d": 30,
    "90d": 90,
}
TARGET_ENV_NORMALIZATION = {
    "non_prod": "non_prod",
    "non-prod": "non_prod",
    "nonprod": "non_prod",
    "dev": "non_prod",
    "preview": "non_prod",
    "prod": "prod",
    "production": "prod",
}
ALLOWED_TABLES = {"usage", "verification", "metadata", "entitlement_snapshot"}
DEV_ENV_VALUES = {"dev", "development", "local"}

CATALOG_HOST = "https://catalog.cloudflarestorage.com"
CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"
DEFAULT_CREDENTIAL_TTL_SECONDS = 3600


class FilePlanRequest(BaseModel):
    project_ids: list[str] = Field(min_length=1, validation_alias=AliasChoices("project_ids", "project_id", "projects"))
    customer_ids: list[str] | None = Field(
        default=None,
        validation_alias=AliasChoices("customer_ids", "customer_id", "customers"),
    )
    tables: list[str] = Field(default_factory=lambda: sorted(ALLOWED_TABLES), validation_alias=AliasChoices("tables", "table"))
    interval: str
    target_env: str = Field(default="non_prod", validation_alias=AliasChoices("target_env", "targetEnv", "env"))

    model_config = ConfigDict(extra="forbid")

    @staticmethod
    def _normalize_id_list(value: Any, field_name: str) -> list[str]:
        if isinstance(value, str):
            raw_values = [value]
        elif isinstance(value, list):
            raw_values = value
        else:
            raise ValueError(f"{field_name} must be a string or an array of strings")

        normalized: list[str] = []
        for item in raw_values:
            if not isinstance(item, str):
                raise ValueError(f"{field_name} entries must be strings")
            normalized_item = item.strip()
            if not normalized_item:
                raise ValueError(f"{field_name} entries must be non-empty strings")
            normalized.append(normalized_item)

        if not normalized:
            raise ValueError(f"{field_name} must include at least one value")
        return list(dict.fromkeys(normalized))

    @field_validator("project_ids", mode="before")
    @classmethod
    def normalize_project_ids(cls, value: Any) -> list[str]:
        return cls._normalize_id_list(value, "project_id")

    @field_validator("customer_ids", mode="before")
    @classmethod
    def normalize_customer_ids(cls, value: Any) -> list[str] | None:
        if value in (None, "", []):
            return None

        if isinstance(value, str):
            normalized_value = value.strip()
            return [normalized_value] if normalized_value else None

        if not isinstance(value, list):
            raise ValueError("customer_id must be null, empty, a string, or an array of strings")

        normalized: list[str] = []
        for item in value:
            if item in (None, ""):
                continue
            if not isinstance(item, str):
                raise ValueError("customer_id entries must be strings")
            normalized_item = item.strip()
            if normalized_item:
                normalized.append(normalized_item)

        if not normalized:
            return None

        return list(dict.fromkeys(normalized))

    @field_validator("tables", mode="before")
    @classmethod
    def normalize_tables(cls, value: Any) -> list[str]:
        if value in (None, "", []):
            return sorted(ALLOWED_TABLES)

        if isinstance(value, str):
            raw_values = [value]
        elif isinstance(value, list):
            raw_values = value
        else:
            raise ValueError("table must be a string or an array of strings")

        normalized: list[str] = []
        for item in raw_values:
            if not isinstance(item, str):
                raise ValueError("all table entries must be strings")
            table_name = item.strip()
            if not table_name:
                raise ValueError("table names must be non-empty strings")
            if table_name not in ALLOWED_TABLES:
                allowed = ", ".join(sorted(ALLOWED_TABLES))
                raise ValueError(f"table must be one of: {allowed}")
            normalized.append(table_name)

        if not normalized:
            raise ValueError("at least one table is required")

        return list(dict.fromkeys(normalized))

    @field_validator("interval", mode="before")
    @classmethod
    def normalize_interval(cls, value: Any) -> str:
        if not isinstance(value, str):
            raise ValueError("interval must be one of 1d, 7d, 30d, 90d")
        interval = value.strip().lower()
        if interval not in INTERVAL_ALIASES:
            raise ValueError("interval must be one of 1d, 7d, 30d, 90d")
        return interval

    @field_validator("target_env", mode="before")
    @classmethod
    def normalize_target_env(cls, value: Any) -> str:
        if value in (None, ""):
            return "non_prod"
        if not isinstance(value, str):
            raise ValueError("target_env must be one of non_prod or prod")
        target_env = value.strip().lower().replace(" ", "_")
        normalized = TARGET_ENV_NORMALIZATION.get(target_env)
        if normalized is None:
            raise ValueError("target_env must be one of non_prod or prod")
        return normalized


def _coerce_utc_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _utc_iso(value: datetime) -> str:
    return _coerce_utc_datetime(value).isoformat().replace("+00:00", "Z")


def _dedupe(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def _get_env_value(env: Any, key: str, default: str | None = None) -> str | None:
    if env is None:
        return default

    value: Any = None
    if isinstance(env, dict):
        value = env.get(key)
    else:
        getter = getattr(env, "get", None)
        if callable(getter):
            try:
                value = getter(key)
            except TypeError:
                try:
                    value = getter(key, None)
                except Exception:
                    value = None
            except Exception:
                value = None

        if value is None:
            try:
                value = env[key]  # type: ignore[index]
            except Exception:
                value = None

        if value is None:
            value = getattr(env, key, None)

    if value is None:
        return default
    if isinstance(value, str):
        return value
    return str(value)


def _require_env(env: Any, key: str) -> str:
    value = _get_env_value(env, key)
    if value is None or not value.strip():
        raise HTTPException(status_code=500, detail=f"Missing required environment variable: {key}")
    return value.strip()


def _create_catalog(*, account_id: str, catalog_name: str, warehouse: str, catalog_token: str) -> RestCatalog:
    catalog_uri = f"{CATALOG_HOST}/{account_id}/{catalog_name}"
    return RestCatalog(name=catalog_name, uri=catalog_uri, warehouse=warehouse, token=catalog_token)


def _build_row_filter(
    *,
    start_dt: datetime,
    end_dt: datetime,
    project_ids: list[str],
    customer_ids: list[str] | None,
):
    predicates: list[Any] = [
        GreaterThanOrEqual("__ingest_ts", _coerce_utc_datetime(start_dt)),
        LessThanOrEqual("__ingest_ts", _coerce_utc_datetime(end_dt)),
    ]

    if len(project_ids) == 1:
        predicates.append(EqualTo("project_id", project_ids[0]))
    else:
        predicates.append(In("project_id", project_ids))

    if customer_ids:
        if len(customer_ids) == 1:
            predicates.append(EqualTo("customer_id", customer_ids[0]))
        else:
            predicates.append(In("customer_id", customer_ids))

    combined = predicates[0]
    for predicate in predicates[1:]:
        combined = And(combined, predicate)
    return combined


def _to_r2_object_key(bucket: str, location: str) -> str:
    if not location:
        return ""

    bucket_s3_prefix = f"s3://{bucket}/"
    if location.startswith(bucket_s3_prefix):
        return location[len(bucket_s3_prefix) :]
    if location.startswith(f"{bucket}/"):
        return location[len(bucket) + 1 :]

    parsed = urlparse(location)
    if parsed.scheme == "s3":
        return parsed.path.lstrip("/")
    if parsed.scheme in {"http", "https"}:
        return parsed.path.lstrip("/")

    return location.lstrip("/")


def _extract_files_from_scan(*, scan: Any, bucket: str) -> tuple[list[str], list[str]]:
    urls: list[str] = []
    prefixes: list[str] = []

    for task in scan.plan_files():
        data_file = getattr(task, "file", None)
        if data_file is None:
            continue

        file_path = str(getattr(data_file, "file_path", "") or "")
        if not file_path:
            continue

        urls.append(file_path)

        key_prefix = _to_r2_object_key(bucket=bucket, location=file_path)
        if key_prefix:
            prefixes.append(key_prefix)

    return _dedupe(urls), _dedupe(prefixes)


def _issue_temp_credentials(
    *,
    account_id: str,
    api_token: str,
    bucket: str,
    parent_access_key_id: str,
    ttl_seconds: int,
    prefixes: list[str],
) -> dict[str, Any]:
    url = f"{CLOUDFLARE_API_BASE}/accounts/{account_id}/r2/temp-access-credentials"
    scoped_prefixes = _dedupe(prefixes)
    body: dict[str, Any] = {
        "bucket": bucket,
        "parentAccessKeyId": parent_access_key_id,
        "permission": "object-read-only",
        "ttlSeconds": ttl_seconds,
    }
    if scoped_prefixes:
        body["prefixes"] = scoped_prefixes

    try:
        response = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {api_token}",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=20,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"R2 temp credentials request failed: {exc}") from exc

    if not response.ok:
        raise RuntimeError(f"R2 temp credentials failed ({response.status_code}): {response.text}")

    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError("R2 temp credentials API returned invalid JSON") from exc

    result = payload.get("result")
    if not payload.get("success") or not isinstance(result, dict):
        raise RuntimeError("R2 temp credentials API returned no result")

    access_key_id = result.get("accessKeyId") or result.get("access_key_id")
    secret_access_key = result.get("secretAccessKey") or result.get("secret_access_key")
    session_token = result.get("sessionToken") or result.get("session_token")
    if not access_key_id or not secret_access_key or not session_token:
        raise RuntimeError("R2 temp credentials response missing fields")

    expiration = result.get("expiration")
    if expiration is None:
        expiration = _utc_iso(datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds))

    return {
        "access_key_id": access_key_id,
        "secret_access_key": secret_access_key,
        "session_token": session_token,
        "expiration": expiration,
        "ttl_seconds": ttl_seconds,
        "prefixes": scoped_prefixes,
    }
