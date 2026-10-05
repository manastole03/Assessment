import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

import { databaseConfig } from '../config/database.config.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * The one Prisma client per process, over a bounded `pg` pool. Only repositories inject it:
 * services and controllers never see the database.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  /** Owned here (not by the adapter) so shutdown can end it: idle connections keep a process alive. */
  private readonly pool: pg.Pool;

  constructor(@Inject(databaseConfig.KEY) config: ConfigType<typeof databaseConfig>) {
    const pool = new pg.Pool({
      connectionString: config.url,
      max: config.poolMax,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      idleTimeoutMillis: 30_000,
      application_name: 'rote-control-plane',
    });
    // An idle connection dropped by the server (restart, failover) must not crash the process;
    // the pool replaces it and the next query reconnects.
    pool.on('error', (error) =>
      new Logger(PrismaService.name).warn(
        { reason: error.message },
        'Idle database connection lost',
      ),
    );
    super({
      adapter: new PrismaPg(pool, { schema: config.schema }),
      log: config.logQueries ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
    this.pool = pool;
  }

  async onModuleInit(): Promise<void> {
    // Fail fast: an API that cannot reach its database should not report itself started.
    await this.$connect();
    await this.ping();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }

  /** Round-trip to the database; throws when it is unreachable. Used by readiness checks. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
