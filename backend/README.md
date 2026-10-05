<div align="center">

# rote control plane

**The secure REST API for rote.** It handles sign-in, users and roles, API keys, approvals, run history, human handoffs and the audit log, and it serves the rote web app.

![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![NestJS](https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![Jest](https://img.shields.io/badge/tested_with-Jest-C21325?logo=jest&logoColor=white)

[Getting started](#-getting-started) · [Architecture](#-architecture) · [API](#-api) · [Authentication](#-authentication-and-roles) · [Deployment](#-deploying-to-production)

![The rote sign-in page, served by the control plane](../docs/images/backend-sign-in.png)

</div>

---

## Contents

- [What it does](#-what-it-does)
- [Getting started](#-getting-started)
- [Screenshots](#-screenshots)
- [Architecture](#-architecture)
- [Repository structure](#-repository-structure)
- [Tech stack](#-tech-stack)
- [Database](#-database)
- [API](#-api)
- [Authentication and roles](#-authentication-and-roles)
- [Configuration](#-configuration)
- [Testing](#-testing)
- [Docker](#-docker)
- [CI/CD](#-cicd)
- [Deploying to production](#-deploying-to-production)
- [Troubleshooting](#-troubleshooting)
- [Design decisions](#-design-decisions)
- [Limitations and roadmap](#-limitations-and-roadmap)
- [Contributing](#-contributing)

---

## ✨ What it does

rote records a back-office task once on a legacy UI, then replays it deterministically (see the [main README](../README.md)). The **rote engine** (Python) does the browser work. **This service** sits in front of it and makes it safe for a team to use:

| Feature                  | What you get                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sign-in and sessions** | Email and password sign-in, sessions that refresh themselves, sign-out that really revokes the session, and account lockout after repeated failures |
| **Roles**                | Four roles: Viewer, Operator, Reviewer and Admin. Every endpoint checks the caller's role on the server.                                            |
| **API keys**             | Keys for scripts, AI agents and MCP clients. A key can never have more access than its owner.                                                       |
| **Approvals**            | A reviewer approves a recorded capability before it can run unattended. Nobody can approve their own recording (the four-eyes rule).                |
| **Run history**          | Every run is indexed in PostgreSQL, wherever it was started, and can be searched, filtered and paged.                                               |
| **Human handoff**        | A queue of runs that need a person. An operator takes over the live session and then hands it back.                                                 |
| **Audit log**            | Who did what and when, for every security-relevant action                                                                                           |
| **Production basics**    | Health checks, structured logs, rate limiting, security headers, Swagger docs and Docker                                                            |

---

## 🚀 Getting started

### Prerequisites

| Tool                             | Version                         | Needed for                                                   |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------ |
| Git                              | any                             | cloning the repo                                             |
| Docker with Compose v2           | recent                          | running everything (option A), or just PostgreSQL (option B) |
| Make, OpenSSL                    | preinstalled on macOS and Linux | shortcuts, and generating secrets                            |
| Node.js                          | 24 or newer                     | option B only: running the backend outside Docker            |
| [uv](https://docs.astral.sh/uv/) | latest                          | option B only: running the Python engine outside Docker      |

> On Windows, use WSL2. The Makefile and scripts expect bash.

### 1. Clone the repository

```bash
git clone https://github.com/manastole03/Assessment.git
cd Assessment
```

### 2. Option A: run everything with Docker (recommended)

Working on backend code? See [Option B](#option-b-run-the-backend-locally-hot-reload) for hot reload.

One command creates your secrets, builds the images and starts the whole stack:

```bash
make up
```

What happens:

1. `make env` creates `.env` and fills in random secrets: the database password, JWT secret, engine token and seed passwords. It never prints or overwrites them.
2. Docker starts **PostgreSQL**, then a one-time **migrate** job that creates the tables and the first users.
3. The **engine** and the **mock target app** start.
4. The **backend** starts once everything it needs is healthy.

When it finishes, open:

| What               | URL                                 |
| ------------------ | ----------------------------------- |
| Web app            | http://localhost:3000               |
| API docs (Swagger) | http://localhost:3000/api/docs      |
| OpenAPI JSON       | http://localhost:3000/api/docs-json |
| Health             | http://localhost:3000/health        |

> Port 3000 already in use? Add `ROTE_HTTP_PORT=3300` to `.env` and run `make up` again.

**Sign in** as `admin@rote.local`. The password was generated into `.env`:

```bash
grep '^SEED_ADMIN_PASSWORD=' .env | cut -d= -f2-
```

Three demo accounts are also created, all with `SEED_DEMO_PASSWORD`: `reviewer@rote.local`, `operator@rote.local` and `viewer@rote.local`.

### 3. Make your first API calls

```bash
API=http://localhost:3000/api/v1
PASSWORD=$(grep '^SEED_ADMIN_PASSWORD=' .env | cut -d= -f2-)

# Sign in and keep the access token
TOKEN=$(curl -s -X POST $API/auth/login \
  -H 'content-type: application/json' \
  -d "{\"email\":\"admin@rote.local\",\"password\":\"$PASSWORD\"}" \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')

# Who am I?
curl -s -w '\n' $API/auth/me -H "authorization: Bearer $TOKEN"

# List users (admins only), 5 per page
curl -s -w '\n' "$API/users?limit=5" -H "authorization: Bearer $TOKEN"

# Create an API key for a script or agent (the secret is shown once)
curl -s -w '\n' -X POST $API/api-keys -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"my script","role":"OPERATOR","expiresInDays":30}'
```

Access tokens last 15 minutes. For anything long-running, use an API key: `Authorization: Bearer rote_…`.

### Option B: run the backend locally (hot reload)

Use this when you are changing backend code. PostgreSQL still runs in Docker.

```bash
make env          # create .env and backend/.env with generated secrets
make db           # PostgreSQL 17 on 127.0.0.1:5433
make migrate      # install dependencies, create the tables, seed the users

cd backend
npm run start:dev # API on http://localhost:3000, restarts on every change
```

The engine is only needed for runs, capabilities and evals. Start it in two more terminals from the repo root:

```bash
make bank         # the mock target app on :8600
make engine       # the rote engine on :8700
```

For the web app with hot reload, also run `make ui-dev` and open http://localhost:5173.

### Stop and reset

```bash
make down                  # stop everything (your data is kept)
docker compose down -v     # stop and DELETE all data, for a clean start
```

### Handy commands

| Command                                       | What it does                                              |
| --------------------------------------------- | --------------------------------------------------------- |
| `make help`                                   | List every target                                         |
| `make up` / `make down` / `make logs`         | Start, stop, or follow the logs of the Docker stack       |
| `make db` / `make migrate` / `make seed`      | PostgreSQL only; apply migrations and seed; seed again    |
| `make backend`                                | Backend in watch mode (same as `npm run start:dev`)       |
| `make test-backend` / `make test-backend-int` | Backend unit tests; integration tests (starts PostgreSQL) |
| `make lint-backend`                           | Type check, ESLint and Prettier                           |
| `make hooks`                                  | Install the git pre-commit hooks                          |

---

## 📸 Screenshots

| Interactive API docs at `/api/docs`                | Every endpoint documents its body and responses                             |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| ![Swagger UI](../docs/images/backend-api-docs.png) | ![The login endpoint in Swagger](../docs/images/backend-api-docs-login.png) |

| The web app it serves                            | A human handoff, powered by the operator API                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| ![Overview page](../docs/images/ui-overview.png) | ![An operator in control of a live session](../docs/images/ui-handoff-in-control.png) |

---

## 🧱 Architecture

### The big picture

```mermaid
flowchart LR
    subgraph Clients
        B["Browser<br/>(React web app)"]
        S["Scripts and CI<br/>(Bearer token)"]
        A["AI agents<br/>(API key or MCP)"]
    end

    subgraph CP["Control plane (this service)"]
        API["NestJS REST API<br/>/api/v1"]
        WEB["Web app files<br/>/"]
    end

    DB[("PostgreSQL<br/>users, sessions, runs,<br/>approvals, audit")]
    ENG["rote engine<br/>(Python, private network)"]
    APP["Target app<br/>(LegacyCore)"]

    B --> WEB
    B --> API
    S --> API
    A --> API
    API --> DB
    API -->|"shared engine token"| ENG
    ENG --> APP
```

- **The control plane** decides **who** can do **what**, and keeps a record of it in PostgreSQL.
- **The engine** keeps the capability files and the run evidence. The control plane reaches it over a private network using a shared token.

### Layers inside the service

Every request goes through the same layers, top to bottom. Each layer has one job.

```mermaid
flowchart TB
    R["HTTP request"] --> MW["Middleware<br/>request id, security headers, CORS, body size limit"]
    MW --> G["Guards<br/>rate limit, then CSRF, then sign-in check, then role check"]
    G --> P["Validation pipe<br/>checks the request against its DTO"]
    P --> C["Controller<br/>routes and status codes only"]
    C --> SV["Service<br/>business rules, transactions, audit"]
    SV --> RP["Repository<br/>the only code that talks to Prisma"]
    SV --> EC["Engine client<br/>validated gateway to the engine"]
    RP --> PR["Prisma"] --> PG[("PostgreSQL")]
    EC --> EN["rote engine"]
    C -.->|result| I["Interceptor<br/>wraps it in the success format"]
    SV -.->|errors| F["Exception filter<br/>wraps it in the error format"]
```

| Layer                                  | Rule                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Controller**                         | Handles HTTP only. No business logic and no database access.                                            |
| **Service**                            | Holds the business rules. Throws `AppException` with a stable error code. Never touches HTTP or Prisma. |
| **Repository**                         | The only place that uses Prisma. Can join a transaction started by a service.                           |
| **Engine client**                      | Treats the engine like a data source. Every engine response is validated with zod before use.           |
| **Guards, pipes, interceptor, filter** | Handle concerns shared by every route, in one place (`src/common/`).                                    |

---

## 📁 Repository structure

### The whole repository

```text
Assessment/
├── backend/              ◀ this service: NestJS control plane (API + serves the web app)
├── ui/                   React 19 + Vite web app (built into the backend image)
├── src/rote/             Python engine: discovery, deterministic replay, handoff, evals
├── src/mockbank/         LegacyCore mock, the demo target app
├── capabilities/         capability library (versioned YAML files)
├── config/               guardrail policy and tenant settings
├── schemas/              JSON Schemas for engine documents
├── evals/                eval datasets
├── evidence/             recorded demonstration runs
├── docker/               engine Dockerfile
├── docs/images/          screenshots used in the READMEs
├── scripts/              ensure-env.sh (secrets) and helper scripts
├── tests/                Python tests
├── docker-compose.yml    the full stack
├── Makefile              every common task (make help)
└── .github/workflows/    CI pipeline
```

### Inside `backend/`

```text
backend/
├── src/
│   ├── main.ts                 starts the app
│   ├── app.module.ts           wires all modules, global guards, rate limiter, scheduler
│   ├── app.setup.ts            the HTTP pipeline (also used by the integration tests)
│   ├── config/                 environment validation, typed config, logging, Swagger
│   ├── common/                 shared code: guards, filters, interceptors, pipes,
│   │                           decorators, error codes, pagination, utilities
│   ├── database/               Prisma service, connection pool, job leases
│   ├── engine/                 client for the Python engine (+ response contracts)
│   ├── health/                 /health, /health/liveness, /health/readiness
│   └── modules/
│       ├── auth/               sign-in, refresh, sign-out, passwords, session cleanup
│       ├── users/              user management
│       ├── api-keys/           API keys for agents and scripts
│       ├── audit/              audit log
│       ├── runs/               runs, live event stream, evidence files, operator handoff
│       ├── interventions/      handoff queue
│       ├── capabilities/       capability library and approvals
│       ├── agents/             tool catalog, invoke, MCP
│       ├── evals/              eval datasets and results
│       └── platform/           status, policy, demo controls
├── prisma/
│   ├── schema.prisma           database schema
│   ├── migrations/             SQL migrations (applied in order)
│   └── seed.ts                 creates the first admin (+ demo users)
├── test/
│   ├── unit/                   fast tests, no database
│   └── integration/            real HTTP + real PostgreSQL + a fake engine
├── Dockerfile                  multi-stage production image
├── .env.example                every setting, documented
└── eslint, prettier, jest, tsconfig, nest-cli configs
```

Each feature module follows the same pattern:

```text
users/
├── users.controller.ts   routes
├── users.service.ts      business rules
├── users.repository.ts   database queries
├── users.module.ts       wiring
├── dto/                  request validation
└── entities/             response shapes (never includes the password hash)
```

---

## 🧰 Tech stack

| Area               | Choice                                                                                |
| ------------------ | ------------------------------------------------------------------------------------- |
| Runtime            | Node.js 24 (LTS), ES modules                                                          |
| Language           | TypeScript in strict mode. No `any` in the source code.                               |
| Framework          | NestJS 12 on Express                                                                  |
| Database           | PostgreSQL 17                                                                         |
| ORM and migrations | Prisma 7 (with the `pg` driver and a connection pool)                                 |
| Validation         | class-validator DTOs for requests; zod for environment variables and engine responses |
| Authentication     | Passport (JWT and API keys), argon2id password hashing                                |
| Security           | helmet, CORS allow-list, rate limiting, CSRF protection                               |
| Logging            | pino (JSON in production, readable in development)                                    |
| API docs           | Swagger / OpenAPI, generated from the code                                            |
| Background jobs    | `@nestjs/schedule` with a database lease, so only one replica runs each job           |
| Tests              | Jest 30 and supertest                                                                 |
| Code quality       | ESLint (type-aware), Prettier, pre-commit hooks                                       |
| Delivery           | Docker (multi-stage, non-root), Docker Compose, GitHub Actions                        |

---

## 💾 Database

```mermaid
erDiagram
    users ||--o{ sessions : "signs in"
    users ||--o{ api_keys : "owns"
    users |o--o{ runs : "requested"
    api_keys |o--o{ runs : "started via"
    runs ||--o{ interventions : "has"
    users |o--o{ interventions : "claimed"
    users |o--o{ capability_approvals : "approved"
    users |o--o{ audit_logs : "acted"

    users {
        uuid id PK
        varchar email UK "stored lower-case"
        varchar name
        text password_hash "argon2id"
        enum role "VIEWER to ADMIN"
        enum status "ACTIVE or DISABLED"
        int failed_login_attempts
        timestamptz locked_until
    }
    sessions {
        uuid id PK
        uuid user_id FK
        char refresh_token_hash UK "SHA-256"
        char previous_token_hash UK "reuse detection"
        timestamptz expires_at
        timestamptz revoked_at
    }
    api_keys {
        uuid id PK
        uuid user_id FK
        varchar prefix UK "public part"
        char key_hash "SHA-256"
        enum role
        timestamptz expires_at
        timestamptz revoked_at
    }
    runs {
        varchar id PK "engine run id"
        enum kind
        enum status
        enum origin
        varchar subject "never raw inputs"
        uuid requested_by_id FK
        uuid api_key_id FK
        timestamptz started_at
    }
    interventions {
        uuid id PK
        varchar run_id FK
        varchar engine_id
        enum status
        uuid claimed_by_id FK
        varchar resolution
    }
    capability_approvals {
        uuid id PK
        varchar capability_id
        varchar version
        uuid approved_by_id FK
        varchar reviewer_email "snapshot"
    }
    audit_logs {
        uuid id PK
        enum actor_type
        uuid actor_id FK
        varchar action
        varchar resource_id
        enum outcome
        jsonb metadata
        timestamptz created_at
    }
    job_leases {
        varchar name PK
        varchar holder
        timestamptz expires_at
    }
```

| Table                  | Stores                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `users`                | Accounts, roles, status and lockout counters                                                    |
| `sessions`             | One row per sign-in. Only hashes of tokens are stored. Cleaned up 30 days after a session ends. |
| `api_keys`             | Keys for agents and scripts. Only a hash of each key is stored.                                 |
| `runs`                 | Index of every engine run, with who started it                                                  |
| `interventions`        | Human handoffs on runs                                                                          |
| `capability_approvals` | Who approved which capability version                                                           |
| `audit_logs`           | Security events (never passwords, tokens or input values)                                       |
| `job_leases`           | Makes sure only one replica runs each background job                                            |

**Good to know**

- IDs are UUIDv7 (time-ordered). Timestamps are `timestamptz`.
- Every foreign key is real and enforced. Deleting a user removes their sessions and keys, while runs, approvals and audit rows keep a snapshot.
- Columns that are searched or sorted often are indexed: `email`, `(status, started_at)`, `(action, created_at)` and others.
- Lists use one query for the page and one for the count, with no N+1 queries. Rules that must not race, such as "always keep one admin", run in serializable transactions.

**Migrations**

```bash
cd backend
npx prisma migrate dev --name add_something   # after editing schema.prisma (development)
npx prisma migrate deploy                     # apply pending migrations (CI and production)
npx prisma studio                             # browse the data
```

---

## 🔌 API

### The basics

- All endpoints live under **`/api/v1`**. A future `/api/v2` can run side by side without breaking v1.
- Requests and responses are JSON. Bodies are limited to 256 kB.
- Every request body and query string is validated. Unknown fields are rejected.
- Full, interactive docs are at **`/api/docs`**.

### Response format

**Success**

```json
{
  "success": true,
  "data": { "id": "…", "email": "dana@example.com" },
  "message": "Request successful"
}
```

**List** (use `?page=1&limit=20`, up to 100 per page)

```json
{ "success": true, "data": [ … ], "meta": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 } }
```

**Error**

```json
{
  "success": false,
  "message": "User not found",
  "error": { "code": "USER_NOT_FOUND" },
  "timestamp": "2026-10-04T00:00:00.000Z",
  "path": "/api/v1/users/0192f0a4-…",
  "requestId": "0f8d3c1e-6b1a-4f43-9d0b-6a3f7b2e9c11"
}
```

Check `error.code` in your code, not `message`. Codes never change meaning. Lists also accept `search`, `sortBy`, `sortOrder` (`asc` or `desc`) and filters such as `status` or `role`. Only known columns can be used for sorting.

### Status codes

| Status                | Common codes                                                                | Meaning                                                                      |
| --------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 200 / 201 / 202 / 204 | —                                                                           | Success (OK, created, accepted, no content)                                  |
| 400                   | `VALIDATION_ERROR`, `MALFORMED_JSON`                                        | The request is invalid; `error.details` lists every bad field                |
| 401                   | `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `INVALID_API_KEY` | Not signed in, or the credentials are wrong or expired                       |
| 403                   | `INSUFFICIENT_ROLE`, `CSRF_TOKEN_INVALID`, `SELF_APPROVAL_FORBIDDEN`        | Signed in, but not allowed                                                   |
| 404                   | `NOT_FOUND`, `USER_NOT_FOUND`, `ROUTE_NOT_FOUND`                            | Doesn't exist                                                                |
| 409                   | `EMAIL_ALREADY_EXISTS`, `LAST_ADMIN`, `LEASE_CONFLICT`                      | Conflicts with the current state                                             |
| 422                   | `INPUT_CONTRACT_VIOLATION`                                                  | Capability inputs don't match its contract                                   |
| 429                   | `RATE_LIMITED`                                                              | Too many requests                                                            |
| 500                   | `INTERNAL_SERVER_ERROR`                                                     | Unexpected; quote the `requestId`. No stack traces or SQL are ever returned. |
| 503                   | `DATABASE_UNAVAILABLE`, `ENGINE_UNAVAILABLE`                                | A dependency is down                                                         |

### Endpoints

| Group            | Main endpoints                                                                             | Who                                |
| ---------------- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| **Auth**         | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me`, `POST /auth/password` | everyone                           |
| **Users**        | `GET/POST /users`, `GET/PATCH/DELETE /users/:id`, `GET/PATCH /users/me`                    | admins (anyone for `/me`)          |
| **API keys**     | `GET/POST /api-keys`, `DELETE /api-keys/:id`                                               | everyone, for their own keys       |
| **Audit**        | `GET /audit-logs`                                                                          | admins                             |
| **Runs**         | `GET/POST /runs`, `GET /runs/:id`, `/runs/:id/stream` (live events), `/runs/:id/files/*`   | read: everyone; start: operators   |
| **Handoff**      | `/runs/:id/operator/…` (watch, claim, input, resolve), `GET /interventions`                | watch: everyone; act: operators    |
| **Capabilities** | `GET /capabilities[/:id]`, `POST /capabilities/:ref/approve`                               | read: everyone; approve: reviewers |
| **Agents**       | `GET /agents/tools`, `POST /capabilities/:id/invoke`, `/mcp`                               | invoke and MCP: operators          |
| **Evals**        | `GET /evals/…`, `POST /evals/runs`                                                         | start: reviewers                   |
| **Platform**     | `GET /status`, `/policy`, `/evidence`, `/demo/…`                                           | everyone                           |
| **Health**       | `GET /health`, `/health/liveness`, `/health/readiness`                                     | public, no `/api/v1` prefix        |

<details>
<summary><b>Full endpoint list (48 paths)</b></summary>

| Method            | Path                                                                              | Role                                          | Purpose                                                  |
| ----------------- | --------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| GET               | `/auth/options`                                                                   | public                                        | Whether sign-up and demo controls are on                 |
| POST              | `/auth/register`                                                                  | public (if `AUTH_ALLOW_SIGNUP`)               | Create a Viewer account and sign in                      |
| POST              | `/auth/login`                                                                     | public                                        | Sign in: cookies + access token                          |
| POST              | `/auth/refresh`                                                                   | refresh cookie + CSRF                         | New access token; rotates the refresh token              |
| POST              | `/auth/logout`                                                                    | optional                                      | Revoke the session; always 204                           |
| GET               | `/auth/me`                                                                        | any                                           | You, and the role this request acts with                 |
| POST              | `/auth/password`                                                                  | any (not API keys)                            | Change password; signs out other sessions                |
| GET               | `/users`                                                                          | Admin                                         | List: search, `role`, `status`, sort, pages              |
| POST              | `/users`                                                                          | Admin                                         | Create a user with a role                                |
| GET, PATCH        | `/users/me`                                                                       | any                                           | Your record; change your display name                    |
| GET               | `/users/:id`                                                                      | Admin, or yourself                            | One user                                                 |
| PATCH             | `/users/:id`                                                                      | Admin                                         | Change name, role or status                              |
| DELETE            | `/users/:id`                                                                      | Admin                                         | Delete (never yourself, never the last admin)            |
| GET               | `/api-keys`                                                                       | any                                           | Your keys (admins: `?userId=` or `?all=true`)            |
| POST              | `/api-keys`                                                                       | any (signed in, not with a key)               | Create; the secret is shown once                         |
| DELETE            | `/api-keys/:id`                                                                   | owner or Admin                                | Revoke                                                   |
| GET               | `/audit-logs`                                                                     | Admin                                         | Filter by action, actor, resource, outcome, dates        |
| GET               | `/runs`                                                                           | any                                           | Filter by status, kind, tenant, origin, `requestedBy=me` |
| POST              | `/runs`                                                                           | Operator (discovery, probe, drafts: Reviewer) | Start a run                                              |
| GET               | `/runs/:id`                                                                       | any                                           | A run with its result and files                          |
| GET               | `/runs/:id/stream`                                                                | any                                           | Live events (Server-Sent Events)                         |
| GET               | `/runs/:id/files/*path`                                                           | any                                           | One evidence file                                        |
| GET               | `/runs/:id/operator/state`, `/screen`, `/live.jpg`                                | any (screen blurred below Operator)           | Watch a live handoff                                     |
| GET               | `/runs/:id/operator/interventions/:iid[/screenshot]`                              | any                                           | One handoff                                              |
| POST              | `/runs/:id/operator/interventions/:iid/claim`                                     | Operator                                      | Take control of the live session                         |
| POST              | `/runs/:id/operator/input`                                                        | Operator (in control)                         | Click, type, press a key                                 |
| POST              | `/runs/:id/operator/interventions/:iid/resolve`                                   | Operator (in control)                         | Hand back control                                        |
| GET               | `/interventions`                                                                  | any                                           | Handoff queue                                            |
| GET               | `/capabilities`, `/capabilities/:id`, `/capabilities/:id/approvals`               | any                                           | Library, details, approval history                       |
| POST              | `/capabilities/:ref/approve`                                                      | Reviewer                                      | Approve a draft (not your own)                           |
| POST              | `/capabilities/:id/invoke`                                                        | Operator                                      | Run a capability and wait for the result                 |
| GET               | `/agents/tools`, `/agents/catalog`                                                | any                                           | Capabilities as tool definitions for agents              |
| GET, POST, DELETE | `/mcp`                                                                            | Operator                                      | MCP endpoint for AI agents                               |
| GET               | `/evals/datasets[/:id]`, `/evals/results[/:id]`, `/evals/results/:id/files/*path` | any                                           | Eval datasets and results                                |
| POST              | `/evals/runs`                                                                     | Reviewer                                      | Start an eval                                            |
| GET               | `/status`, `/policy`, `/evidence`                                                 | any                                           | Environment, guardrails, evidence index                  |
| GET, PUT          | `/demo/members`, `/demo/faults/:tenant`                                           | any; PUT needs Operator                       | Demo controls (when `DEMO_ENABLED`)                      |
| GET               | `/health`, `/health/liveness`, `/health/readiness`                                | public                                        | Health checks                                            |

</details>

---

## 🔐 Authentication and roles

### How sign-in works

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant API as Control plane
    participant DB as PostgreSQL

    U->>API: POST /auth/login (email, password)
    API->>DB: Find the user and check the argon2id hash
    API->>DB: Create a session (only a hash of the refresh token is stored)
    API-->>U: 200 with an access token and cookies

    U->>API: GET /runs (cookie or Bearer token)
    API->>DB: Load the session and user. Revoked? Disabled? Which role?
    API-->>U: 200 with the data

    Note over U,API: The access token expires after 15 minutes
    U->>API: POST /auth/refresh (refresh cookie + CSRF token)
    API->>DB: Swap in a new refresh token. Reusing an old one revokes the session.
    API-->>U: 200 with new tokens

    U->>API: POST /auth/logout
    API->>DB: Revoke the session
    API-->>U: 204
```

### Three ways to authenticate

| Client                       | How                                                   | Details                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Browser**                  | Cookies set by `/auth/login`                          | `rote_at` (access, httpOnly), `rote_rt` (refresh, httpOnly, sent only to `/api/v1/auth`), `rote_csrf` (sent back as the `X-CSRF-Token` header on writes). All are `SameSite=Strict`. |
| **Script**                   | `Authorization: Bearer <accessToken>`                 | The token from the login response. Lasts 15 minutes.                                                                                                                                 |
| **Agent / MCP / automation** | `Authorization: Bearer rote_…` or `X-API-Key: rote_…` | Create one with `POST /api-keys`. It can expire, and it can be revoked at any time.                                                                                                  |

### Roles

Roles are ranked. Each role can do everything the roles above it in this table can.

| What you can do                                             | Viewer | Operator | Reviewer | Admin |
| ----------------------------------------------------------- | :----: | :------: | :------: | :---: |
| See runs, capabilities, evals, status and the handoff queue |   ✅   |    ✅    |    ✅    |  ✅   |
| Start replays, invoke capabilities, use MCP                 |        |    ✅    |    ✅    |  ✅   |
| Take over a live handoff and see the unblurred screen       |        |    ✅    |    ✅    |  ✅   |
| Run discovery or probe, run unapproved drafts, start evals  |        |          |    ✅    |  ✅   |
| Approve capabilities (not your own recordings)              |        |          |    ✅    |  ✅   |
| Manage users, see everyone's API keys, read the audit log   |        |          |          |  ✅   |

### Security built in

- Passwords are hashed with **argon2id** and never returned by the API. They must be 12–128 characters, and not only letters or only digits.
- Every sign-in failure returns the **same answer in the same time**, so attackers can't tell which emails exist.
- **Lockout:** 5 failed logins lock the account for 15 minutes.
- The user's **role is read from the database** on every request, so demoting or disabling someone works immediately.
- **Refresh tokens rotate.** If a stolen token is used again, the session is revoked.
- **API keys** are stored as hashes and capped at their owner's current role.
- **CSRF protection** for cookie-based requests; **rate limits** per IP, stricter on sign-in.
- **Security headers** (helmet and CSP), a **CORS allow-list** and **request size limits**.
- **Logs never contain** passwords, tokens, cookies or API keys; they are redacted.

---

## 🔧 Configuration

All settings come from environment variables. The app checks them at startup and **refuses to start** with a clear list if any are missing or invalid. Use `.env.example` as the template; `make env` creates `.env` for you.

**Required**

| Variable              | Example                                                      | Notes                                                    |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| `DATABASE_URL`        | `postgresql://rote:secret@localhost:5433/rote?schema=public` | PostgreSQL connection                                    |
| `JWT_SECRET`          | 48 random characters                                         | At least 32 characters. Placeholder values are rejected. |
| `ENGINE_TOKEN`        | 32 random characters                                         | Required in production. Shared with the engine.          |
| `SEED_ADMIN_PASSWORD` | 18 random characters                                         | Only for the seed script: the first admin's password     |

<details>
<summary><b>All optional settings (with defaults)</b></summary>

| Variable                                          | Default                           | What it does                                                                 |
| ------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| `NODE_ENV`                                        | `development`                     | `development`, `production` or `test`                                        |
| `PORT` / `HOST`                                   | `3000` / `0.0.0.0`                | Where the server listens                                                     |
| `LOG_LEVEL`                                       | `info`                            | `trace` (also logs SQL), `debug`, `info`, `warn`, `error`, `fatal`, `silent` |
| `PUBLIC_URL`                                      | `http://localhost:3000`           | The address users reach. With `https://`, HSTS is turned on.                 |
| `CORS_ORIGIN`                                     | empty                             | Comma-separated origins allowed to call the API from another site            |
| `TRUST_PROXY`                                     | `0`                               | How many proxies sit in front, for correct client IPs                        |
| `DATABASE_POOL_MAX`                               | `10`                              | Connections per instance                                                     |
| `DATABASE_CONNECTION_TIMEOUT_MS`                  | `5000`                            |                                                                              |
| `JWT_EXPIRES_IN`                                  | `15m`                             | Access token lifetime                                                        |
| `JWT_ISSUER` / `JWT_AUDIENCE`                     | `rote-control-plane` / `rote`     | Checked on every token                                                       |
| `REFRESH_TOKEN_TTL_DAYS`                          | `7`                               | How long a sign-in lasts                                                     |
| `COOKIE_SECURE`                                   | `true` in production              | Set `false` only for plain-http localhost                                    |
| `AUTH_ALLOW_SIGNUP`                               | `false`                           | Allow self sign-up (as Viewer)                                               |
| `AUTH_MAX_FAILED_LOGINS` / `AUTH_LOCKOUT_MINUTES` | `5` / `15`                        | Lockout policy                                                               |
| `APPROVAL_REQUIRE_SEPARATE_REVIEWER`              | `true`                            | The four-eyes rule                                                           |
| `ENGINE_URL`                                      | `http://127.0.0.1:8700`           | Where the engine is                                                          |
| `ENGINE_TIMEOUT_MS`                               | `15000`                           | Default timeout for engine calls                                             |
| `ENGINE_ALLOW_HEADED`                             | `false`                           | Allow visible browser windows on the engine host                             |
| `RUN_SYNC_ENABLED` / `RUN_SYNC_INTERVAL_MS`       | `true` / `5000`                   | Background sync of the run index                                             |
| `DEMO_ENABLED`                                    | `false`                           | Demo controls for the mock app                                               |
| `SWAGGER_ENABLED`                                 | `true`                            | Serve `/api/docs`                                                            |
| `RATE_LIMIT_TTL_MS` / `RATE_LIMIT_MAX`            | `60000` / `600`                   | General rate limit per IP                                                    |
| `AUTH_RATE_LIMIT_MAX`                             | `10`                              | Rate limit per IP on sign-in endpoints                                       |
| `UI_DIST_PATH`                                    | empty                             | Folder of the built web app to serve at `/`                                  |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_NAME`            | `admin@rote.local` / `Rote Admin` | Seed only                                                                    |
| `SEED_DEMO_USERS` / `SEED_DEMO_PASSWORD`          | `false` / —                       | Seed only: also create the three demo accounts                               |

</details>

> Never commit `.env`. It is git-ignored, and so are `node_modules/`, `dist/`, `coverage/` and logs.

---

## 🧪 Testing

```bash
cd backend
npm run test:unit          # fast: no database needed
npm run test:integration   # real PostgreSQL: run `make db` first
npm run test:cov           # unit tests with a coverage report
```

```mermaid
flowchart LR
    subgraph Unit["Unit tests (no database)"]
        U1[Services and business rules]
        U2[Guards, filters, interceptor]
        U3[Validation and config]
    end
    subgraph Integration["Integration tests"]
        I1[Real HTTP requests] --> I2[Controllers, guards, services] --> I3[Repositories] --> I4[("Real PostgreSQL<br/>(temporary schema)")]
    end
```

- **Unit tests** check business rules with mocked dependencies: user rules, sign-in and lockout, API keys, approvals, guards, error mapping, validation and config.
- **Integration tests** boot the real app with the same pipeline as production and call it over HTTP. Each run creates its own temporary database schema and deletes it afterwards, so your data is never touched. A fake engine stands in for the Python service.
- They cover success cases, invalid input, 401, 403, 404, 409, 422 and 429 responses, CSRF, token reuse, lockout, a database outage, an engine outage, live streaming and path-traversal attempts.

Tips: `TEST_LOGS=1` shows app logs, and `KEEP_TEST_SCHEMA=1` keeps the test schema so you can inspect it.

---

## 🐳 Docker

```mermaid
flowchart LR
    PG[("postgres<br/>localhost:5433")] -->|healthy| MIG["migrate<br/>one-time: migrations + seed"]
    MIG -->|finished| BE["backend<br/>localhost:3000<br/>web app + API"]
    PG --> BE
    ENG["engine<br/>private :8700"] -->|healthy| BE
    BANK["bank<br/>mock target app"] -.-|shares network| ENG
```

| Service           | Purpose                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| `postgres`        | PostgreSQL 17. Its data lives in a named volume. Reachable only from localhost. |
| `migrate`         | Runs once: applies migrations, then seeds the users. The backend waits for it.  |
| `engine` / `bank` | The rote engine and the mock app it drives (private network only)               |
| `backend`         | This service, in production mode                                                |

**The production image** (`backend/Dockerfile`) is built in stages, so the final image contains only what it needs to run:

- Small base (`node:24-alpine`), about **160 MB**
- Production dependencies only, with compiled JavaScript and the built web app
- Runs as the **non-root** `node` user
- `tini` as PID 1 for clean shutdowns
- A built-in health check

```bash
# Build the image yourself (from the repo root: it also builds the web app)
docker build -f backend/Dockerfile --target runtime -t rote-backend .
```

---

## 🔄 CI/CD

Every push and pull request runs [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Any failure stops the pipeline.

```mermaid
flowchart LR
    A[Install] --> B["Lint<br/>ESLint + Prettier"] --> C[Type check] --> D[Unit tests] --> E["Integration tests<br/>real PostgreSQL"] --> F["Migration check<br/>schema matches migrations"] --> G[Build]
    G --> H["Docker build<br/>after the UI and engine jobs also pass"]
```

Run the same checks locally before you push:

```bash
cd backend
npm run lint && npm run format:check && npm run typecheck \
  && npm run test:unit && npm run test:integration && npm run build
```

---

## 🌐 Deploying to production

```mermaid
flowchart LR
    U[Users and agents] -->|HTTPS| LB["Load balancer<br/>TLS"]
    LB --> R1[backend replica 1]
    LB --> R2[backend replica 2]
    LB --> RN[backend replica N]
    R1 --> PG[("PostgreSQL<br/>managed")]
    R2 --> PG
    RN --> PG
    R1 --> EN["rote engine<br/>private network"]
    R2 --> EN
    RN --> EN
    MJ["Release job<br/>prisma migrate deploy"] -.->|before each rollout| PG
```

**Checklist**

1. **Build** the `runtime` image and push it to your registry.
2. **Set secrets** from your secret manager (never bake them into the image): `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET`, `ENGINE_TOKEN`, `ENGINE_URL` and an `https://` `PUBLIC_URL`.
3. **Run migrations first**, as a release step: `npx prisma migrate deploy`. The app never changes the schema on its own, so replicas never race.
4. **Seed once** for the first admin: `npx prisma db seed`. It's safe to re-run and never resets passwords.
5. **Health checks:** liveness on `/health/liveness`, readiness on `/health/readiness`.
6. **Behind a proxy**, set `TRUST_PROXY` (usually `1`).
7. **Scale** by adding replicas. The API is stateless, and background jobs elect one leader through the database. Keep `replicas × DATABASE_POOL_MAX` below PostgreSQL's connection limit.
8. **Lock it down:** keep `DEMO_ENABLED=false`, and consider `SWAGGER_ENABLED=false` on public deployments.
9. **Logs** go to stdout as JSON lines (timestamp, level, request id, user, method, path, status, duration), ready for any log collector.

---

## 🩺 Troubleshooting

| Problem                                              | Fix                                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `make up` fails with `set POSTGRES_PASSWORD in .env` | Run `make env` (or just `make up`, which runs it first).                                                                         |
| Port 3000 is already in use                          | Add `ROTE_HTTP_PORT=3300` to `.env`, then `make up`.                                                                             |
| The app exits with `Invalid configuration`           | Read the list in the message; it names every bad variable. Compare with `.env.example`.                                          |
| `/health` says `"status": "degraded"`                | The engine is down. Check `docker compose logs engine`. Sign-in and users still work.                                            |
| `503 ENGINE_UNAVAILABLE` in local development        | Start `make bank` and `make engine`.                                                                                             |
| `Cannot find module …/generated/prisma/client.js`    | Run `npx prisma generate` in `backend/`. The generated client isn't committed.                                                   |
| Integration tests say they need PostgreSQL           | Run `make db`, or set `TEST_DATABASE_URL`.                                                                                       |
| `403 CSRF_TOKEN_INVALID` from a script               | Scripts should use a Bearer token or an API key instead of cookies.                                                              |
| Login keeps failing with the right password          | The account is locked after 5 failures; wait 15 minutes.                                                                         |
| Lost the admin password                              | It's `SEED_ADMIN_PASSWORD` in `.env`. For a completely fresh start: `docker compose down -v && make up` (this deletes all data). |

---

## 🧭 Design decisions

- **One service, many modules** (a modular monolith). Simple to run and deploy, and each module could become its own service later. The engine is already separate because it runs browsers.
- **Sessions live in the database.** This costs one fast lookup per request, and in return sign-out, disabling a user and role changes take effect immediately.
- **Cookies for browsers, tokens for programs.** Cookies keep tokens away from JavaScript; scripts and agents use Bearer tokens or API keys.
- **Four ranked roles** instead of a complex permission matrix. Easy to understand and audit.
- **Stable error codes** are part of the API contract.
- **Migrations run as a separate release step**, never when the app starts.
- **No Redis or message queue yet.** Background jobs use a database lease. Add more infrastructure only when the load needs it.
- **pre-commit instead of Husky.** This repo mixes Python, a web app and this backend. The existing pre-commit hooks already run ESLint, Prettier and the type check for the backend.

---

## 📌 Limitations and roadmap

| Today                                                                                   | Next step                                                      |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Rate limits are counted per instance                                                    | A shared store (Redis) or gateway rate limits when scaling out |
| No password reset by email, no MFA or SSO                                               | OIDC single sign-on                                            |
| Audit writes are best effort (a failure is logged, not fatal)                           | Write audit rows in the same transaction (outbox)              |
| No retention policy for `audit_logs` and `runs` (sessions are cleaned up after 30 days) | Configurable retention                                         |
| Logs and request ids only                                                               | Metrics and tracing with OpenTelemetry                         |
| Engine-backed lists are paged in memory                                                 | Paging in the engine for very large libraries                  |

---

## 🤝 Contributing

1. Create a branch: `git checkout -b feat/short-description`.
2. Install the hooks once: `make hooks`. They lint, format and type-check on every commit.
3. Follow the layers: controller → service → repository. Add a DTO for every input and a test for every rule.
4. Changed `schema.prisma`? Add a migration with `npx prisma migrate dev --name …`.
5. Run the checks (see [CI/CD](#-cicd)) and open a pull request.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(auth): add session cleanup job` or `fix(api): reject unknown query params`.

---

<div align="center">

Part of **[rote](../README.md)**. Private project (`UNLICENSED`).

</div>
