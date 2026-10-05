-- CreateEnum
CREATE TYPE "Role" AS ENUM ('VIEWER', 'OPERATOR', 'REVIEWER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('REPLAY', 'DISCOVERY', 'PROBE');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'BUSINESS_OUTCOME', 'FAILED', 'ERROR', 'INTERRUPTED');

-- CreateEnum
CREATE TYPE "RunOrigin" AS ENUM ('CONTROL_PLANE', 'ENGINE', 'EVIDENCE');

-- CreateEnum
CREATE TYPE "InterventionStatus" AS ENUM ('OPEN', 'CLAIMED', 'RESOLVED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'API_KEY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" CHAR(64) NOT NULL,
    "previous_token_hash" CHAR(64),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "ip_address" VARCHAR(64),
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "prefix" VARCHAR(32) NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "role" "Role" NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" VARCHAR(200) NOT NULL,
    "kind" "RunKind" NOT NULL,
    "status" "RunStatus" NOT NULL,
    "origin" "RunOrigin" NOT NULL,
    "subject" VARCHAR(300) NOT NULL,
    "tenant" VARCHAR(64),
    "capability_ref" VARCHAR(200),
    "escalation" VARCHAR(16),
    "result_code" VARCHAR(64),
    "requested_by_id" UUID,
    "api_key_id" UUID,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "interventions_synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interventions" (
    "id" UUID NOT NULL,
    "run_id" VARCHAR(200) NOT NULL,
    "engine_id" VARCHAR(64) NOT NULL,
    "reason_code" VARCHAR(64) NOT NULL,
    "status" "InterventionStatus" NOT NULL,
    "step_id" VARCHAR(100),
    "claimed_by" VARCHAR(254),
    "claimed_by_id" UUID,
    "resolution" VARCHAR(32),
    "note" VARCHAR(2000),
    "claimed_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "interventions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_approvals" (
    "id" UUID NOT NULL,
    "capability_id" VARCHAR(200) NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "approved_by_id" UUID,
    "reviewer_email" VARCHAR(254) NOT NULL,
    "reviewer_name" VARCHAR(120) NOT NULL,
    "notes" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capability_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "actor_email" VARCHAR(254),
    "api_key_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "resource_type" VARCHAR(64),
    "resource_id" VARCHAR(200),
    "outcome" "AuditOutcome" NOT NULL,
    "metadata" JSONB,
    "ip_address" VARCHAR(64),
    "request_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_leases" (
    "name" VARCHAR(64) NOT NULL,
    "holder" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_previous_token_hash_key" ON "sessions"("previous_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "runs_started_at_idx" ON "runs"("started_at" DESC);

-- CreateIndex
CREATE INDEX "runs_status_started_at_idx" ON "runs"("status", "started_at" DESC);

-- CreateIndex
CREATE INDEX "runs_kind_idx" ON "runs"("kind");

-- CreateIndex
CREATE INDEX "runs_tenant_idx" ON "runs"("tenant");

-- CreateIndex
CREATE INDEX "runs_origin_idx" ON "runs"("origin");

-- CreateIndex
CREATE INDEX "runs_requested_by_id_idx" ON "runs"("requested_by_id");

-- CreateIndex
CREATE INDEX "interventions_status_created_at_idx" ON "interventions"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "interventions_claimed_by_id_idx" ON "interventions"("claimed_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "interventions_run_id_engine_id_key" ON "interventions"("run_id", "engine_id");

-- CreateIndex
CREATE INDEX "capability_approvals_approved_by_id_idx" ON "capability_approvals"("approved_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "capability_approvals_capability_id_version_key" ON "capability_approvals"("capability_id", "version");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_claimed_by_id_fkey" FOREIGN KEY ("claimed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_approvals" ADD CONSTRAINT "capability_approvals_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
