# rote: `make up` runs the whole stack (Postgres, control plane + UI, engine, mock bank) in Docker.
# For development, `make dev` prepares the database, then run `make bank`, `make engine`,
# `make backend` and `make ui-dev` in separate terminals. The demo targets below drive the engine CLI.
SHELL := /bin/bash
REVIEWER ?= reviewer
MEMBER ?= 12345
BALANCE := legacycore.member.get_savings_balance
SESSION := legacycore.session.sign_on
FAULT := uv run mockbank fault

.PHONY: help setup env up down logs dev db migrate seed engine backend backend-install bank ui ui-build ui-dev \
        discover-session discover approve show replay replay-other evidence evidence-offline \
        demo-not-found demo-restricted demo-recoveries demo-hard-failure demo-handoff \
        demo-tenant catalog validate eval eval-live eval-replay test test-py test-ui test-backend test-backend-int \
        lint lint-py lint-ui lint-backend fmt check docker-build hooks ui-install clean-faults

help:  ## Show this help
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[1m%-20s\033[0m %s\n", $$1, $$2}'

setup: env backend-install ui-install  ## Install everything (Python + Chromium, backend, UI) and create the env files
	uv sync
	uv run playwright install chromium

env:  ## Create .env / backend/.env and fill in any missing secrets (never prints or overwrites values)
	./scripts/ensure-env.sh

# ---------------------------------------------------------------- the whole stack in Docker

up: env  ## Build and start everything; UI + API on http://localhost:3000 (ROTE_HTTP_PORT)
	docker compose up --build -d
	@echo "UI + API: http://localhost:$${ROTE_HTTP_PORT:-3000}   API docs: /api/docs   Health: /health"
	@echo "Sign in as admin@rote.local with SEED_ADMIN_PASSWORD from .env (demo users: SEED_DEMO_PASSWORD)."

down:  ## Stop the stack (keeps the database and evidence volumes; add -v to docker compose down to drop them)
	docker compose down

logs:  ## Follow the stack's logs
	docker compose logs -f backend engine

docker-build:  ## Build the backend and engine images
	docker compose build

# ---------------------------------------------------------------- local development (no Docker except Postgres)

dev: env db migrate  ## Prepare local development; then run bank, engine, backend and ui-dev in four terminals
	@echo "Database ready. Now, in separate terminals: make bank · make engine · make backend · make ui-dev"

db:  ## Postgres only, on 127.0.0.1:5433 (POSTGRES_HOST_PORT)
	docker compose up -d --wait postgres

migrate: backend-install  ## Apply database migrations and seed the users (idempotent)
	cd backend && npx prisma migrate deploy && npx prisma db seed

seed: backend-install  ## Seed the admin (and demo users) again; existing users are left alone
	cd backend && npx prisma db seed

engine:  ## The engine API on 127.0.0.1:8700 (token from .env), for a local backend
	uv run rote engine

backend: backend-install  ## The control plane in watch mode (port from backend/.env)
	cd backend && npm run start:dev

backend-install:
	@if [ ! -d backend/node_modules ]; then cd backend && npm ci; fi
	@cd backend && npx prisma generate > /dev/null

bank:  ## Run the LegacyCore mock (both tenants) on :8600
	uv run mockbank serve

ui: up  ## Alias for `make up` (the UI is served by the control plane)

ui-build: ui-install  ## Build the React UI into ui/dist (served by the control plane; Docker builds it too)
	cd ui && npm run build

ui-install:
	@if [ ! -d ui/node_modules ]; then cd ui && npm ci; fi

ui-dev:  ## Hot-reloading UI on :5173, proxying /api and /health to the backend (ROTE_API_TARGET)
	cd ui && npm run dev

# ---------------------------------------------------------------- discovery (LLM, needs ANTHROPIC_API_KEY)

discover-session:  ## LLM records the sign-on capability
	uv run rote discover "Sign on to LegacyCore with the operator's service account" --kind session --tenant acme --id $(SESSION)

discover:  ## LLM records the savings-balance capability
	uv run rote discover "Look up member $(MEMBER) and read their current share savings balance and the member's name" \
	  -i member_id=$(MEMBER) --tenant acme --id $(BALANCE)

approve:  ## Approve both capabilities after review
	uv run rote approve $(SESSION) --reviewer "$(REVIEWER)"
	uv run rote approve $(BALANCE) --reviewer "$(REVIEWER)"

show:  ## Review sheet for the balance capability
	uv run rote show $(BALANCE)

# ---------------------------------------------------------------- replay (deterministic, no model)

replay:  ## Replay for member 12345
	uv run rote replay $(BALANCE) -i member_id=$(MEMBER)

replay-other:  ## Same artifact, a member whose share rows are in a different order
	uv run rote replay $(BALANCE) -i member_id=20417

demo-not-found:  ## Business outcome: no such member
	uv run rote replay $(BALANCE) -i member_id=99999 || true

demo-restricted:  ## Business outcome: restricted (employee) account
	uv run rote replay $(BALANCE) -i member_id=40404 || true

demo-recoveries:  ## Interstitial + native dialog + 503 + session expiry, all recovered
	$(FAULT) acme maintenance_notice=true session_warning_dialog=true transient_errors=1 session_expire_after=2
	uv run rote replay $(BALANCE) -i member_id=$(MEMBER)

demo-hard-failure:  ## Unannounced vendor redesign → TARGET_NOT_FOUND with evidence
	$(FAULT) acme vendor_upgrade=true
	uv run rote replay $(BALANCE) -i member_id=$(MEMBER) || true
	$(FAULT) acme --clear

demo-handoff:  ## Unknown screen → operator takes the live session (open the console URL printed)
	$(FAULT) acme compliance_popup=true
	uv run rote replay $(BALANCE) -i member_id=$(MEMBER) --escalation wait --headed || true
	$(FAULT) acme --clear

demo-tenant:  ## Same artifact on Bayview (relabelled, renamed products, security notice)
	uv run rote show $(BALANCE) --tenant bayview
	uv run rote replay $(BALANCE) -i member_id=20417 --tenant bayview

evidence:  ## Regenerate /evidence with the REAL model (needs ANTHROPIC_API_KEY in .env)
	uv run python scripts/make_evidence.py

evidence-offline:  ## Regenerate /evidence with a scripted stand-in for the model (no key)
	uv run python scripts/make_evidence.py --offline

catalog:  ## Approved capabilities as agent-callable tool definitions
	uv run rote catalog

validate:  ## Schema + policy + PII lint over the library
	uv run rote validate

# ---------------------------------------------------------------- evals (hermetic: private mock bank, throwaway library)

eval:  ## All eval datasets offline (replay is model-free; probe/discovery use scripted stand-ins)
	uv run rote eval run replay
	uv run rote eval run probe
	uv run rote eval run discovery

eval-replay:  ## Replay dataset, 3 trials per case: pass^3 is the determinism check
	uv run rote eval run replay --trials 3

eval-live:  ## Probe + discovery with the real model and the model-graded rubric (needs ANTHROPIC_API_KEY)
	uv run rote eval run probe --live
	uv run rote eval run discovery --live

# ---------------------------------------------------------------- quality

test: test-py test-ui test-backend  ## Python (starts its own mock bank), UI and backend unit suites; no API key or database

test-py:
	uv run pytest -q

test-ui: ui-install
	cd ui && npm test

test-backend: backend-install  ## Backend unit tests
	cd backend && npm run test:unit

test-backend-int: backend-install db  ## Backend integration tests (real Postgres, throwaway schema, fake engine)
	cd backend && npm run test:integration

lint: lint-py lint-ui lint-backend  ## Ruff, ruff format, mypy; ESLint, Prettier, tsc (UI and backend)

lint-py:
	uv run ruff check src tests scripts
	uv run ruff format --check src tests scripts
	uv run mypy src

lint-ui: ui-install
	cd ui && npm run typecheck && npm run lint && npm run format:check

lint-backend: backend-install
	cd backend && npm run typecheck && npm run lint && npm run format:check

fmt:  ## Apply formatters and safe lint fixes
	uv run ruff format src tests scripts
	uv run ruff check --fix src tests scripts
	@if [ -d ui/node_modules ]; then cd ui && npm run format && npm run lint:fix; fi
	@if [ -d backend/node_modules ]; then cd backend && npm run format && npm run lint:fix; fi

check: lint validate test test-backend-int eval  ## Everything CI runs (except the Docker build)

hooks:  ## Install the git pre-commit hooks
	uvx pre-commit install

clean-faults:  ## Reset the mock bank
	uv run mockbank reset
