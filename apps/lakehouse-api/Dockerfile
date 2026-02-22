FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev

COPY src ./src

EXPOSE 8080

CMD ["sh", "-c", "./.venv/bin/uvicorn src.worker:app --host 0.0.0.0 --port ${PORT:-8080}"]
