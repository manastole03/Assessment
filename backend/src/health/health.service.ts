import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service.js';
import { EngineClient } from '../engine/engine.client.js';
import { API_VERSION } from '../modules/platform/platform.service.js';

const CHECK_TIMEOUT_MS = 2000;

export interface LivenessReport {
  status: 'ok';
  timestamp: string;
  uptimeSeconds: number;
}

export interface ReadinessReport {
  status: 'ok' | 'error';
  database: 'connected' | 'disconnected';
  timestamp: string;
}

export interface HealthReport {
  /** ok: everything up; degraded: serving, but runs need the engine; error: not serving. */
  status: 'ok' | 'degraded' | 'error';
  database: 'connected' | 'disconnected';
  engine: 'connected' | 'unreachable';
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineClient,
  ) {}

  /** The process is up and its event loop responds. Never touches dependencies. */
  liveness(): LivenessReport {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /**
   * Can this instance serve traffic? Only the database decides: without the engine the API still
   * serves identity, lists and audit, so an engine outage must not pull every replica out of rotation.
   */
  async readiness(): Promise<ReadinessReport> {
    const database = await this.databaseState();
    return {
      status: database === 'connected' ? 'ok' : 'error',
      database,
      timestamp: new Date().toISOString(),
    };
  }

  async health(): Promise<HealthReport> {
    const [database, engineUp] = await Promise.all([
      this.databaseState(),
      this.engine.isReachable(CHECK_TIMEOUT_MS),
    ]);
    const status = database === 'disconnected' ? 'error' : engineUp ? 'ok' : 'degraded';
    return {
      status,
      database,
      engine: engineUp ? 'connected' : 'unreachable',
      version: API_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  private async databaseState(): Promise<'connected' | 'disconnected'> {
    try {
      await withTimeout(this.prisma.ping(), CHECK_TIMEOUT_MS);
      return 'connected';
    } catch {
      return 'disconnected';
    }
  }
}
