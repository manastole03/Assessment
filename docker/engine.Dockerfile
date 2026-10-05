# syntax=docker/dockerfile:1.7
# The rote engine (Python): replay, discovery, probes, live sessions and evidence, behind the control
# plane. The same image also runs the bundled LegacyCore mock (`mockbank serve`).
# Build context is the repository root:
#   docker build -f docker/engine.Dockerfile -t rote-engine .

FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    PYTHONUNBUFFERED=1 \
    ROTE_HOME=/app

WORKDIR /app

# Dependencies first (cached until the lockfile changes), then Chromium and its system libraries.
COPY pyproject.toml uv.lock README.md ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project
RUN playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY src/ ./src/
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev

# The library and configuration the engine runs (reviewed in git). capabilities/ and runs/ are
# volumes in compose: approvals and evidence must outlive the container.
COPY capabilities/ ./capabilities/
COPY config/ ./config/
COPY schemas/ ./schemas/
COPY evals/ ./evals/
COPY evidence/ ./evidence/

RUN useradd --create-home --uid 10001 rote \
 && mkdir -p /app/runs \
 && chown -R rote:rote /app/runs /app/capabilities
USER rote

EXPOSE 8700
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8700/api/health', timeout=2)"
# Listening beyond loopback requires ROTE_ENGINE_TOKEN (the engine refuses to start otherwise).
CMD ["rote", "engine", "--host", "0.0.0.0", "--port", "8700"]
