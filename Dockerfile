FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.10.10 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY floorguard ./floorguard
COPY runs ./runs
COPY evidence ./evidence
RUN uv sync --frozen --no-dev
ENV PORT=8080 LLM_PROVIDER=nebius
EXPOSE 8080
CMD ["sh", "-c", "uv run --no-dev uvicorn floorguard.api:app --host 0.0.0.0 --port ${PORT}"]
