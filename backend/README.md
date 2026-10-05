# rote control plane (backend)

The authenticated REST API in front of the rote engine. It owns **identity, roles, approvals, the run index, human handoffs and the audit trail**, and serves the built web UI. The Python engine stays the source of truth for capability artifacts (reviewed YAML in git) and run evidence (files). This service decides **who** may do **what** with them and records it.

```text
browser / script / agent ──▶ control plane (NestJS, this directory) ──▶ PostgreSQL
                                  │  /api/v1 · /health · /api/docs · UI
                                  ▼
                              rote engine (Python, internal) ──▶ target app
```

- **Stack:** Node.js 24, TypeScript (strict), NestJS 12, PostgreSQL 17, Prisma 7, Jest, Docker.
- **API:** `/api/v1/...`, OpenAPI at **`/api/docs`** (JSON at `/api/docs-json`), probes at `/health`.
- **Quality gates:** `npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build`, the same commands CI runs.

---

## Contents

1. [Quick start](#quick-start)
2. [Architecture](#architecture)
3. [Project structure](#project-structure)
4. [Technology choices](#technology-choices)
5. [Database schema](#database-schema)
6. [API](#api)
7. [Authentication and authorization](#authentication-and-authorization)
8. [Configuration](#configuration)
9. [Local development](#local-development)
10. [Testing](#testing)
11. [Docker](#docker)
12. [Production deployment](#production-deployment)
13. [Architectural decisions](#architectural-decisions)
14. [Limitations and TODOs](#limitations-and-todos)

---

## Quick start

From the repository root:

```bash
make up        # generates secrets into .env, then builds and starts Postgres, migrations, engine, mock and backend
```

Open `http://localhost:3000` (UI), `http://localhost:3000/api/docs` (API docs) or `http://localhost:3000/health`. Sign in as `admin@rote.local` with `SEED_ADMIN_PASSWORD` from `./.env`. Change the host port with `ROTE_HTTP_PORT`.

---

## Architecture

A modular monolith with strict layers. Every request takes the same path:

```text
HTTP request
  → middleware      request id (AsyncLocalStorage) · helmet · cookie parser · body limits · CORS
  → guards          ThrottlerGuard → CsrfGuard → JwtAuthGuard (who) → RolesGuard (what)
  → pipes           global ValidationPipe (DTOs: whitelist, forbidNonWhitelisted, transform)
  → controller      HTTP only: route, DTO, @CurrentUser(), status code
  → service         business rules, coordination, transactions, audit
  → repository      the only code that touches Prisma
  → Prisma → PostgreSQL
  ← interceptor     wraps the result in the success envelope
  ← exception filter turns every error into the error envelope
```

| Layer          | Rule                                                                                                                                                                                                          | Where                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Controllers    | No business logic, no database. Return plain data; the interceptor envelopes it.                                                                                                                              | `src/modules/*/*.controller.ts` |
| Services       | Business rules and transactions. Throw `AppException` with a stable code. Never see HTTP or Prisma.                                                                                                           | `src/modules/*/*.service.ts`    |
| Repositories   | All Prisma calls. Accept an optional transaction client so services can compose atomic work.                                                                                                                  | `src/modules/*/*.repository.ts` |
| Engine gateway | The engine is a second data source. `EngineClient` hides HTTP, validates every response with zod (anti-corruption layer), and maps failures to `AppException`. Services use it the way they use repositories. | `src/engine/`                   |
| Cross-cutting  | Guards, filters, interceptors, pipes, decorators, middleware.                                                                                                                                                 | `src/common/`                   |
| Configuration  | Zod-validated at startup. The app refuses to boot on a missing or invalid variable.                                                                                                                           | `src/config/`                   |

`PrismaService` is injected only by repositories, `database/` and the readiness probe (`HealthService` → `PrismaService.ping()`). Services use the generated types and enums, never the client. The only raw SQL is that probe's `SELECT 1`.

---

## Project structure

```text
backend/
├── src/
│   ├── main.ts                    bootstrap: logger, configureApp(), listen
│   ├── app.module.ts              module graph, global guards, throttler, scheduler, static UI
│   ├── app.setup.ts               the HTTP pipeline (shared verbatim by main.ts and integration tests)
│   ├── config/                    validation.ts (zod env schema), configuration.ts, database.config.ts,
│   │                              logger.config.ts (pino + redaction), swagger.config.ts
│   ├── common/
│   │   ├── constants/             error codes (API contract), roles and ranking, header/cookie names
│   │   ├── decorators/            @Public, @OptionalAuth, @MinRole, @CurrentUser, @RawResponse, Swagger helpers
│   │   ├── dto/                   PaginationQueryDto, ListQueryDto, envelope models
│   │   ├── exceptions/            AppException (code + client-safe message + details)
│   │   ├── filters/               AllExceptionsFilter (the error envelope; hides internals)
│   │   ├── guards/                CsrfGuard, RolesGuard
│   │   ├── interceptors/          ResponseEnvelopeInterceptor
│   │   ├── middleware/            request id
│   │   ├── pipes/                 ValidationPipe factory, engine id / evidence path pipes
│   │   ├── utils/                 pagination, crypto, request context, strings (LIKE escaping)
│   │   └── validators/            bounded record validators
│   ├── database/                  PrismaService (owned pg pool), PrismaModule, JobLeaseRepository
│   ├── engine/                    EngineClient, zod contracts for engine responses, streaming proxy
│   ├── health/                    /health, /health/liveness, /health/readiness
│   ├── generated/prisma/          generated client (git-ignored; `npx prisma generate`)
│   └── modules/
│       ├── auth/                  login, refresh rotation, logout, password change, strategies, session cleanup
│       ├── users/                 user management, argon2id hashing
│       ├── api-keys/              keys for agents and MCP clients
│       ├── audit/                 append-only audit trail (global module)
│       ├── runs/                  run index, start runs, SSE, evidence files, operator handoff, background sync
│       ├── interventions/         handoff queue
│       ├── capabilities/          library, approval workflow (four-eyes rule)
│       ├── agents/                tool catalog, invoke, MCP relay
│       ├── evals/                 datasets, results, start evals
│       └── platform/              status, policy, evidence index, demo controls
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts                    idempotent: first admin (+ optional demo users) from env
├── test/
│   ├── unit/                      services, guards, filter, interceptor, validation, config, mappers
│   ├── integration/               real HTTP stack + real Postgres (throwaway schema) + fake engine
│   └── helpers/
├── Dockerfile                     multi-stage: ui → deps → build → prod-deps → runtime
├── prisma.config.ts               Prisma CLI config (migrations, seed)
├── eslint.config.mjs · prettier.config.js · jest.config.mjs · jest.integration.config.mjs
├── tsconfig.json · tsconfig.build.json · nest-cli.json
└── .env.example
```

`docker-compose.yml`, `Makefile`, `.github/workflows/ci.yml` and `.pre-commit-config.yaml` live at the repository root because they orchestrate the engine and UI too.

---

## Technology choices

| Concern    | Choice                                                                                                    | Why                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Runtime    | Node.js 24 (LTS), ESM                                                                                     | NestJS 12 is ESM-only.                                                                              |
| Language   | TypeScript, `strict` + `noUncheckedIndexedAccess`, `noImplicitOverride`                                   | No `any` in `src/` (ESLint `no-explicit-any: error`, type-aware rules on).                          |
| Framework  | NestJS 12 (Express)                                                                                       | Modules, DI, guards, pipes, interceptors and filters map one-to-one onto the required layers.       |
| Database   | PostgreSQL 17                                                                                             | Relational integrity, `timestamptz`, enums, serializable transactions.                              |
| ORM        | Prisma 7 with the `pg` driver adapter                                                                     | Typed queries and migrations. The app owns the `pg` pool so it can be sized and closed on shutdown. |
| Validation | class-validator DTOs (requests); zod (environment, engine responses)                                      | DTOs drive Swagger; zod gives one fail-fast error listing every bad variable.                       |
| Auth       | Passport (JWT + custom API-key strategy), `@nestjs/jwt` HS256, argon2id                                   | See [Authentication](#authentication-and-authorization).                                            |
| Security   | helmet (strict CSP; looser only on `/api/docs`), CORS allow-list, `@nestjs/throttler`, double-submit CSRF |                                                                                                     |
| Logging    | pino via nestjs-pino                                                                                      | JSON lines in production, pretty in development, credential redaction.                              |
| Docs       | `@nestjs/swagger` with the CLI plugin                                                                     | Generated from the same DTOs the ValidationPipe enforces, so docs cannot drift from validation.     |
| Jobs       | `@nestjs/schedule` + a database lease                                                                     | Background work runs on one replica without adding Redis.                                           |
| Tests      | Jest 30 (ESM), supertest                                                                                  | Unit tests with typed mocks; integration tests against real Postgres.                               |
| Quality    | ESLint (typescript-eslint, type-checked), Prettier, pre-commit hooks                                      | Enforced in CI with `--max-warnings=0`.                                                             |

---

## Database schema

```mermaid
erDiagram
    users ||--o{ sessions : "signs in (cascade)"
    users ||--o{ api_keys : "owns (cascade)"
    users |o--o{ runs : "requested (set null)"
    api_keys |o--o{ runs : "via key (set null)"
    runs ||--o{ interventions : "has (cascade)"
    users |o--o{ interventions : "claimed (set null)"
    users |o--o{ capability_approvals : "approved (set null)"
    users |o--o{ audit_logs : "actor (set null)"
```

| Table                  | Purpose                                                                                                                  | Keys and constraints                                                     | Indexes                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `users`                | Accounts. `role` ∈ VIEWER < OPERATOR < REVIEWER < ADMIN; `status` ACTIVE/DISABLED; lockout counters.                     | UUIDv7 PK; `email` unique (stored lower-cased)                           | role, status, created_at                                                                                |
| `sessions`             | One sign-in on one device: a rotating refresh-token family. Stores SHA-256 hashes, never tokens.                         | `refresh_token_hash` and `previous_token_hash` unique; FK user (cascade) | user_id, expires_at                                                                                     |
| `api_keys`             | Credentials for agents and MCP clients. Public `prefix` + SHA-256 of the full key; role capped at the owner's.           | `prefix` unique; FK user (cascade)                                       | user_id                                                                                                 |
| `runs`                 | Index of every engine run (started here, from the CLI, or checked-in evidence), with attribution. Subjects are redacted. | Natural PK = engine run id; FKs requester and API key (set null)         | (started_at desc), (status, started_at desc), kind, tenant, origin, requested_by_id                     |
| `interventions`        | Human handoffs on runs: the operator queue and its history.                                                              | (run_id, engine_id) unique; FK run (cascade), claimant (set null)        | (status, created_at desc), claimed_by_id                                                                |
| `capability_approvals` | Who approved which capability version (four-eyes rule). Snapshots the reviewer so it survives user deletion.             | (capability_id, version) unique                                          | approved_by_id                                                                                          |
| `audit_logs`           | Append-only security trail. Holds identifiers and codes only, never secrets or input values.                             | FK actor (set null)                                                      | (created_at desc), (actor_id, created_at desc), (action, created_at desc), (resource_type, resource_id) |
| `job_leases`           | Leader election for background jobs across replicas.                                                                     | PK `name`                                                                | —                                                                                                       |

All timestamps are `timestamptz(3)`. Mutable tables have `created_at` and `updated_at`; the append-only `audit_logs` and `capability_approvals` have `created_at`; `job_leases` has `expires_at` and `updated_at`. Deleting a user removes their sessions and keys; runs, approvals and audit rows keep a snapshot and null the FK.

Migrations live in `prisma/migrations/`. CI applies them to a fresh database and fails if `schema.prisma` has drifted from them.

---

## API

### Conventions

- **Base path:** `/api/v1`. The version is URI-based (`VersioningType.URI`, default `1`), so a `@Version('2')` controller can add `/api/v2/...` alongside v1 without breaking it. Health probes are unversioned at `/health`.
- **JSON in, JSON out.** Bodies are capped at 256 kB.
- **Success envelope:**
  ```json
  { "success": true, "data": {}, "message": "Request successful" }
  ```
- **Collections** (`?page=1&limit=20`, limit ≤ 100):
  ```json
  { "success": true, "data": [], "meta": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 } }
  ```
- **Errors** (every error, whatever raised it):
  ```json
  {
    "success": false,
    "message": "User not found",
    "error": { "code": "USER_NOT_FOUND" },
    "timestamp": "2026-10-04T00:00:00.000Z",
    "path": "/api/v1/users/0192…",
    "requestId": "0f8d3c1e-…"
  }
  ```
  Clients branch on `error.code`, never on `message`. Codes are listed in `src/common/constants/error-codes.ts` and in the OpenAPI schema. `VALIDATION_ERROR` lists every invalid field in `error.details`. Unexpected errors return `INTERNAL_SERVER_ERROR` with the request id. The stack, SQL and driver messages are logged, never returned. Database outages return `503 DATABASE_UNAVAILABLE`.
- **Lists** accept `search`, `sortBy` (a per-resource allow-list, mapped explicitly to Prisma `orderBy`) and `sortOrder=asc|desc`, plus resource filters such as `status`, `role`, `kind` or `tenant`. Unknown query parameters are rejected.
- **Exceptions to the envelope:** health probes, streams (SSE), files and images, and MCP (JSON-RPC). These are marked `@RawResponse()`.

### Endpoints

"Any" means any authenticated user (VIEWER and up). Roles are ranked, so a higher role always passes.

| Method                                                      | Path                                                                              | Role                                                | Purpose                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| **auth**                                                    |                                                                                   |                                                     |                                                                     |
| GET                                                         | `/auth/options`                                                                   | public                                              | Whether sign-up and demo controls are enabled                       |
| POST                                                        | `/auth/register`                                                                  | public (if `AUTH_ALLOW_SIGNUP`)                     | Create a VIEWER account and sign in                                 |
| POST                                                        | `/auth/login`                                                                     | public                                              | Sign in: session cookies + access token                             |
| POST                                                        | `/auth/refresh`                                                                   | refresh cookie + CSRF                               | Rotate the refresh token, new access token                          |
| POST                                                        | `/auth/logout`                                                                    | optional                                            | Revoke the session (by access token or refresh cookie); always 204  |
| GET                                                         | `/auth/me`                                                                        | any                                                 | The caller and their effective role                                 |
| POST                                                        | `/auth/password`                                                                  | any (not API keys)                                  | Change password; signs out other sessions                           |
| **users**                                                   |                                                                                   |                                                     |                                                                     |
| GET                                                         | `/users`                                                                          | ADMIN                                               | List: search, `role`, `status`, sort, paginate                      |
| POST                                                        | `/users`                                                                          | ADMIN                                               | Create a user with a role                                           |
| GET / PATCH                                                 | `/users/me`                                                                       | any                                                 | Own record / update display name                                    |
| GET                                                         | `/users/:id`                                                                      | ADMIN, or self                                      | One user (others get 404, not 403)                                  |
| PATCH                                                       | `/users/:id`                                                                      | ADMIN                                               | Name, role, status (no self-demotion; never the last admin)         |
| DELETE                                                      | `/users/:id`                                                                      | ADMIN                                               | Delete (not self; never the last admin)                             |
| **api-keys**                                                |                                                                                   |                                                     |                                                                     |
| GET                                                         | `/api-keys`                                                                       | any                                                 | Own keys (admins: `?userId=` / `?all=true`)                         |
| POST                                                        | `/api-keys`                                                                       | any (session only)                                  | Create; the secret is returned once                                 |
| DELETE                                                      | `/api-keys/:id`                                                                   | owner or ADMIN                                      | Revoke                                                              |
| **audit**                                                   |                                                                                   |                                                     |                                                                     |
| GET                                                         | `/audit-logs`                                                                     | ADMIN                                               | Filter by action, actor, resource, outcome, time range              |
| **runs**                                                    |                                                                                   |                                                     |                                                                     |
| GET                                                         | `/runs`                                                                           | any                                                 | Index: status, kind, tenant, origin, `requestedBy=me`, search, sort |
| POST                                                        | `/runs`                                                                           | OPERATOR (discovery, probe, `allowDraft`: REVIEWER) | Start a run                                                         |
| GET                                                         | `/runs/:id`                                                                       | any                                                 | Run with result, interventions, files                               |
| GET                                                         | `/runs/:id/stream`                                                                | any                                                 | Server-Sent Events                                                  |
| GET                                                         | `/runs/:id/files/*path`                                                           | any                                                 | Evidence file (sandboxing CSP on HTML)                              |
| GET                                                         | `/runs/:id/operator/{state,screen,live.jpg}`                                      | any (live screen masked below OPERATOR)             | Watch a live handoff                                                |
| GET                                                         | `/runs/:id/operator/interventions/:iid[/screenshot]`                              | any                                                 | One intervention                                                    |
| POST                                                        | `/runs/:id/operator/interventions/:iid/claim`                                     | OPERATOR                                            | Take the lease (in the caller's name)                               |
| POST                                                        | `/runs/:id/operator/input`                                                        | OPERATOR (lease holder)                             | Click / type / key / dialog                                         |
| POST                                                        | `/runs/:id/operator/interventions/:iid/resolve`                                   | OPERATOR (lease holder)                             | Hand back with a resolution                                         |
| GET                                                         | `/interventions`                                                                  | any                                                 | Handoff queue across runs                                           |
| **capabilities and agents**                                 |                                                                                   |                                                     |                                                                     |
| GET                                                         | `/capabilities`, `/capabilities/:id`, `/capabilities/:id/approvals`               | any                                                 | Library, review sheet, approval history                             |
| POST                                                        | `/capabilities/:ref/approve`                                                      | REVIEWER                                            | Approve a draft (four-eyes rule)                                    |
| POST                                                        | `/capabilities/:id/invoke`                                                        | OPERATOR                                            | Invoke; 200 with the result or 202 + `Location`                     |
| GET                                                         | `/agents/tools`, `/agents/catalog`                                                | any                                                 | Approved capabilities as tool definitions                           |
| GET / POST / DELETE                                         | `/mcp`                                                                            | OPERATOR                                            | MCP Streamable HTTP relay (use an API key)                          |
| **evals and platform**                                      |                                                                                   |                                                     |                                                                     |
| GET                                                         | `/evals/datasets[/:id]`, `/evals/results[/:id]`, `/evals/results/:id/files/*path` | any                                                 | Datasets and results                                                |
| POST                                                        | `/evals/runs`                                                                     | REVIEWER                                            | Start an eval (one at a time)                                       |
| GET                                                         | `/status`, `/policy`, `/evidence`                                                 | any                                                 | Engine environment, guardrails, evidence index                      |
| GET / PUT                                                   | `/demo/members`, `/demo/faults/:tenant`                                           | any / OPERATOR                                      | Mock controls (only when `DEMO_ENABLED`)                            |
| **health** (unversioned, unauthenticated, not rate-limited) |                                                                                   |                                                     |                                                                     |
| GET                                                         | `/health`                                                                         | public                                              | `ok`, `degraded` (engine down) or `error` (database down, 503)      |
| GET                                                         | `/health/liveness`                                                                | public                                              | The process responds. Touches no dependencies.                      |
| GET                                                         | `/health/readiness`                                                               | public                                              | The database answers (503 if not)                                   |

The OpenAPI document at `/api/docs` is authoritative. It documents every request body, query parameter, response model, error status and security scheme.

---

## Authentication and authorization

### Credentials

| Client                        | Credential                                | Sent as                                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser (the UI)              | Session cookies from `POST /auth/login`   | `rote_at` (access JWT, httpOnly) on every request; `rote_rt` (refresh token, httpOnly, path `/api/v1/auth`) only to auth endpoints; `rote_csrf` (readable) echoed as `X-CSRF-Token` on writes |
| Script, short-lived           | The `accessToken` from the login response | `Authorization: Bearer <jwt>`                                                                                                                                                                 |
| Agent, MCP client, automation | An API key from `POST /api-keys`          | `Authorization: Bearer rote_…` or `X-API-Key: rote_…`                                                                                                                                         |

All cookies are `SameSite=Strict`, and `Secure` by default in production.

### Flow

```text
POST /auth/login {email, password}
  → user by email; argon2id verify (unknown emails verify against a dummy hash: equal timing)
  → failures increment a counter; AUTH_MAX_FAILED_LOGINS locks the account for AUTH_LOCKOUT_MINUTES
    (every failure, including "locked", returns the same INVALID_CREDENTIALS)
  → create a session row (refresh token stored as SHA-256), issue:
       access JWT  {sub: userId, sid: sessionId, typ: "access"}, HS256, iss/aud checked, 15 min
       refresh token  256-bit opaque, 7 days
       CSRF token

Every request
  → ThrottlerGuard   per-IP limits; stricter `auth` bucket on login/register/password
  → CsrfGuard        cookie-authenticated writes must echo rote_csrf; bearer/API-key requests skip it
  → JwtAuthGuard     API key strategy first, then JWT (bearer, then cookie).
                     The JWT's session is loaded from the database: it must exist, be unrevoked and
                     unexpired, and its user must be ACTIVE. Role comes from the database, not the token,
                     so demotion, disabling and sign-out take effect immediately.
  → RolesGuard       @MinRole(...) against the user's current role (capped by the API key's role)

POST /auth/refresh  (refresh cookie + CSRF)
  → compare-and-set rotation: the old hash moves to previous_token_hash
  → presenting a previous token again means it leaked: the whole session is revoked (REFRESH_TOKEN_REUSED)

POST /auth/logout   (@OptionalAuth)
  → revokes the session behind the access token (cookie or bearer), else behind the refresh cookie
```

**API keys** look like `rote_<8 hex>_<43 chars>`. The prefix is a public lookup id; only the SHA-256 of the whole key is stored, compared in constant time. A key's role is fixed at creation (at most the creator's) and is further capped at the owner's **current** role on every request. Keys cannot create keys or change passwords.

**Authorization** is server-side only. Roles come from the database on every request, never from the client. Routes declare the lowest role they accept with `@MinRole`. Rules that depend on the payload live in services: discovery needs REVIEWER, admins cannot demote themselves, the last active admin is protected, and a reviewer cannot approve a version recorded by a run they started.

Passwords: argon2id (OWASP baseline: 19 MiB, t=2, p=1), 12–128 characters, not only letters or only digits. Hashes are rehashed transparently when parameters change, and never leave the repository layer: entities are mapped to response DTOs through an allow-list.

---

## Configuration

Copy `.env.example` to `.env` (or run `make env` at the repo root, which generates every secret). Every variable is validated at startup (`src/config/validation.ts`). A missing or invalid value stops the app with a list of every problem. In `production` and `test`, `.env` is ignored and only the real environment is read.

| Variable                                          | Default                       | Notes                                                                                       |
| ------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                        | `development`                 | `development` \| `production` \| `test`                                                     |
| `PORT` / `HOST`                                   | `3000` / `0.0.0.0`            |                                                                                             |
| `LOG_LEVEL`                                       | `info`                        | `trace` (also logs SQL) … `fatal`, `silent`                                                 |
| `PUBLIC_URL`                                      | `http://localhost:3000`       | Base URL users reach; used in links. `https://` enables HSTS and upgrade-insecure-requests. |
| `CORS_ORIGIN`                                     | empty (no cross-origin)       | Comma-separated allow-list. The UI is same-origin and needs nothing.                        |
| `TRUST_PROXY`                                     | `0`                           | Number of proxies in front (correct client IPs for rate limits and audit)                   |
| `DATABASE_URL`                                    | **required**                  | `postgresql://user:pass@host:5432/db?schema=public`                                         |
| `DATABASE_POOL_MAX`                               | `10`                          | Per instance. Keep `replicas × pool` below Postgres `max_connections`.                      |
| `DATABASE_CONNECTION_TIMEOUT_MS`                  | `5000`                        |                                                                                             |
| `JWT_SECRET`                                      | **required**                  | ≥ 32 characters; placeholder values are rejected. Rotating it signs everyone out.           |
| `JWT_EXPIRES_IN`                                  | `15m`                         | Access token lifetime (`900s`, `15m`, `1h`)                                                 |
| `JWT_ISSUER` / `JWT_AUDIENCE`                     | `rote-control-plane` / `rote` | Checked on every token                                                                      |
| `REFRESH_TOKEN_TTL_DAYS`                          | `7`                           |                                                                                             |
| `COOKIE_SECURE`                                   | `true` in production          | Set `false` only for plain-http localhost                                                   |
| `AUTH_ALLOW_SIGNUP`                               | `false`                       | Self-service VIEWER accounts                                                                |
| `AUTH_MAX_FAILED_LOGINS` / `AUTH_LOCKOUT_MINUTES` | `5` / `15`                    |                                                                                             |
| `APPROVAL_REQUIRE_SEPARATE_REVIEWER`              | `true`                        | Four-eyes rule for capability approval                                                      |
| `ENGINE_URL`                                      | `http://127.0.0.1:8700`       |                                                                                             |
| `ENGINE_TOKEN`                                    | required in production        | Shared secret with the engine, ≥ 16 characters                                              |
| `ENGINE_TIMEOUT_MS`                               | `15000`                       | Default per engine call (streams have none)                                                 |
| `ENGINE_ALLOW_HEADED`                             | `false`                       | Allow visible browser windows on the engine host                                            |
| `RUN_SYNC_ENABLED` / `RUN_SYNC_INTERVAL_MS`       | `true` / `5000`               | Background run-index sync                                                                   |
| `DEMO_ENABLED`                                    | `false`                       | Fault injection and sample members for the bundled mock                                     |
| `SWAGGER_ENABLED`                                 | `true`                        | Serve `/api/docs`                                                                           |
| `RATE_LIMIT_TTL_MS` / `RATE_LIMIT_MAX`            | `60000` / `600`               | Global per-IP window                                                                        |
| `AUTH_RATE_LIMIT_MAX`                             | `10`                          | Per-IP window on credential endpoints                                                       |
| `UI_DIST_PATH`                                    | empty                         | Built UI to serve at `/` (the Docker image sets it)                                         |

Seed only (`prisma/seed.ts`; the running app never reads these): `SEED_ADMIN_EMAIL` (default `admin@rote.local`), `SEED_ADMIN_NAME`, `SEED_ADMIN_PASSWORD` (**required**, same password policy), `SEED_DEMO_USERS`, `SEED_DEMO_PASSWORD` (reviewer@, operator@, viewer@rote.local).

---

## Local development

Prerequisites: Node.js 24, Docker (for Postgres). Python/uv is needed only to run the engine.

```bash
# from the repository root
make env            # creates .env and backend/.env with generated secrets (never prints or overwrites them)
make db             # Postgres 17 on 127.0.0.1:5433 (POSTGRES_HOST_PORT)
make migrate        # npm ci (first time) + prisma generate + migrate deploy + seed

cd backend
npm run start:dev   # watch mode on PORT from backend/.env; pretty logs
```

For runs, capabilities and evals the engine must be running too: `make bank` and `make engine` in two more terminals. Without it those endpoints answer `503 ENGINE_UNAVAILABLE` and `/health` reports `degraded`, while identity, users, keys and audit keep working. For the UI with hot reload, run `make ui-dev` (Vite on :5173, proxying `/api` and `/health` here).

| Task                                        | Command                                          |
| ------------------------------------------- | ------------------------------------------------ |
| New migration after editing `schema.prisma` | `npx prisma migrate dev --name <change>`         |
| Regenerate the client                       | `npx prisma generate`                            |
| Browse data                                 | `npx prisma studio`                              |
| Lint / fix                                  | `npm run lint` / `npm run lint:fix`              |
| Format                                      | `npm run format` (check: `npm run format:check`) |
| Type check                                  | `npm run typecheck`                              |
| Install git hooks (repo root)               | `make hooks`                                     |

---

## Testing

```bash
npm run test:unit          # fast; no database, no engine
npm run test:cov           # unit tests with coverage (coverage/)
npm run test:integration   # needs Postgres: `make db` first, or set TEST_DATABASE_URL
```

- **Unit tests** (`test/unit/`) cover services and business rules (users, auth, API keys, capabilities, runs, session cleanup), guards (roles, CSRF), the exception filter (Prisma, body-parser, database-down mapping), the envelope interceptor, DTO validation, environment validation, pagination, the engine client's error mapping and health.
- **Integration tests** (`test/integration/`) boot the real `AppModule` with the production HTTP pipeline (`configureApp`) against real PostgreSQL. A fake engine stands in for the Python service. Each run creates and migrates its own schema (`it_<random>`) and drops it afterwards, so it never touches development data and parallel CI jobs can share a server. They cover success paths, validation failures (including unknown fields and query parameters), 401, 403, 404, 409, 422, 429 rate limiting, CSRF rules, refresh-token reuse, lockout, role changes taking effect mid-session, a database outage (`503 DATABASE_UNAVAILABLE`, no driver details leaked), an engine outage (`degraded`), SSE streaming, path traversal and the MCP relay.

Set `TEST_LOGS=1` to see application logs and `KEEP_TEST_SCHEMA=1` to keep the schema for inspection.

---

## Docker

**Image** (`backend/Dockerfile`, built from the repository root because it also builds `ui/`):

```bash
docker build -f backend/Dockerfile --target runtime -t rote-backend .
```

Stages: `ui` (React build) → `deps` → `build` (Prisma generate + `nest build`; also the image of the migration job) → `prod-deps` (`npm ci --omit=dev`) → `runtime`. The runtime image is `node:24-alpine` with production dependencies only and the compiled `dist/`. It runs as the unprivileged `node` user under `tini` (so SIGTERM triggers Nest's graceful shutdown) and has a `HEALTHCHECK` on `/health/liveness`. It is about 160 MB.

**Compose** (`docker-compose.yml` at the root) runs the whole stack:

| Service          | Role                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `postgres`       | PostgreSQL 17, port bound to `127.0.0.1:${POSTGRES_HOST_PORT:-5433}`, named volume                                         |
| `migrate`        | One-shot release job: `prisma migrate deploy` then the idempotent seed. The backend waits for it to complete successfully. |
| `engine`, `bank` | The rote engine and the bundled mock target app (internal network only)                                                    |
| `backend`        | This service on `${ROTE_HTTP_PORT:-3000}`, `NODE_ENV=production`                                                           |

```bash
make up                         # = make env + docker compose up --build -d
make logs                       # follow backend + engine logs
make down                       # stop (volumes kept; `docker compose down -v` drops them)
docker compose up -d --wait postgres   # Postgres only (= make db)
```

Compose refuses to start if `POSTGRES_PASSWORD`, `JWT_SECRET`, `ENGINE_TOKEN` or `SEED_ADMIN_PASSWORD` are missing from `.env`.

---

## Production deployment

1. **Build and push** the `runtime` target. CI already builds it on every push.
2. **Provide configuration** from your secret store, never from a file in the image: `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET` (random, ≥ 32 characters), `ENGINE_TOKEN`, `ENGINE_URL`, `PUBLIC_URL` (https). Set `TRUST_PROXY` to the number of proxies in front. Leave `DEMO_ENABLED` off, and consider `SWAGGER_ENABLED=false` on internet-facing deployments.
3. **Migrate as a release step**, before the new version takes traffic: run `npx prisma migrate deploy` from the `build` target with the production `DATABASE_URL`. The API never migrates itself, so replicas never race on schema changes. Write migrations to be backward compatible (expand, deploy, then contract), because old replicas keep serving during a rollout.
4. **Seed once** for the first admin (`npx prisma db seed` with `SEED_ADMIN_*`). It is idempotent and never resets an existing password.
5. **Wire probes:** liveness `GET /health/liveness`, readiness `GET /health/readiness` (database only, so an engine outage does not pull every replica out of rotation). `GET /health` is the human-facing summary.
6. **Scale horizontally.** The API is stateless: sessions live in Postgres and background jobs elect a leader through `job_leases`. Size `DATABASE_POOL_MAX` per replica, or put PgBouncer in front for many replicas.
7. **Terminate TLS** at the load balancer. Cookies are `Secure` in production. With an `https` `PUBLIC_URL`, HSTS is sent.
8. **Logs** are JSON lines on stdout (timestamp, level, request id, user id, method, path, status, duration) with credentials redacted. Ship them with your platform's collector. `X-Request-Id` is accepted from upstream, echoed back, put on every log line and error body, and forwarded to the engine.

---

## Architectural decisions

- **Modular monolith, not microservices.** One deployable with feature modules that only talk through exported services. The engine is already a separate service because it runs browsers; nothing else needs to be.
- **The engine is a data source, behind a gateway.** `EngineClient` plays the repository role for engine-owned data. Every response is validated with zod (fields the control plane reads are typed; the rest passes through), so an engine change fails loudly at the boundary instead of deep in a service. Engine documents keep their snake_case keys and their own JSON Schemas (`schemas/`).
- **Postgres indexes runs; the engine stays authoritative.** Runs started anywhere are copied into `runs` by a leader-leased background sync, which reconciles in three statements regardless of size, so lists, filters and attribution are database queries. Reading one run fetches it live and writes it through.
- **Database-backed sessions over stateless JWTs.** Each request does one indexed lookup (`sessions` by id, joined to `users`). In exchange, sign-out, disabling a user and role changes take effect immediately, and refresh-token theft is detectable.
- **Cookies for browsers, headers for programs.** httpOnly cookies let SSE and `<img>` evidence authenticate without exposing tokens to JavaScript. CSRF is handled by `SameSite=Strict` plus a double-submit token. The CSRF check is skipped only when a bearer token or API key authenticates the request.
- **Ranked roles** (VIEWER < OPERATOR < REVIEWER < ADMIN) and `@MinRole`, rather than permission matrices. That is enough for this domain and simple to audit. Payload-dependent rules live in services.
- **Stable error codes as API contract.** One `AppException` type, one global filter, and `error.code` values that are added but never renamed.
- **Migrations are a release job, not a startup step.**
- **No Redis or queue.** Background work (run sync, session cleanup) uses `@nestjs/schedule` with a Postgres lease, which is enough at this scale (see limitations).
- **Pre-commit instead of Husky.** This is a polyglot repository (Python, UI, backend). The `pre-commit` framework already runs the backend's ESLint, Prettier and `tsc` on commit (`make hooks`), so Husky would run the same checks twice.

---

## Limitations and TODOs

- **Rate limits are per instance.** The throttler uses in-memory storage, so N replicas allow N× the configured rate. If strict global limits matter, move it to a shared store (Redis) or enforce limits at the gateway.
- **Engine-backed collections are paginated in memory.** Capabilities, eval results and tool lists are fetched whole from the engine and sliced. This is fine for libraries in the hundreds; it needs engine-side paging beyond that.
- **No self-service password reset, email verification, MFA or SSO.** There is no email infrastructure. Admins create accounts and users change their own passwords. OIDC SSO would be the natural next step for an organization.
- **Audit writes are best effort.** A failed audit insert is logged as an error but does not fail the action. A strictly compliant deployment would write audit rows in the same transaction or through an outbox.
- **Retention:** ended sessions are purged after 30 days (daily job). `audit_logs` and `runs` have no retention policy yet.
- **Observability:** structured logs and request ids only. No metrics endpoint or distributed tracing yet (OpenTelemetry would slot in at `main.ts`).
- **Access-token checks hit the database** on every request (by design, see above). Add a short-lived cache if that lookup becomes a hotspot.
