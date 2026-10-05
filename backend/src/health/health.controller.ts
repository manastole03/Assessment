import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';

import { Public, RawResponse } from '../common/decorators/metadata.decorators.js';
import {
  type HealthReport,
  HealthService,
  type LivenessReport,
  type ReadinessReport,
} from './health.service.js';

/**
 * Probes for orchestrators and load balancers: unversioned, unauthenticated, not rate limited,
 * and in their own small format (not the API envelope) so any probe can read them.
 */
@ApiTags('health')
@Public()
@SkipThrottle()
@RawResponse()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Overall health: database and engine' })
  @ApiResponse({ status: 200, description: 'ok or degraded (engine unreachable)' })
  @ApiResponse({ status: 503, description: 'database unreachable' })
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await this.health.health();
    if (report.status === 'error') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  @Get('liveness')
  @ApiOperation({ summary: 'Liveness: the process responds (restart it if not)' })
  liveness(): LivenessReport {
    return this.health.liveness();
  }

  @Get('readiness')
  @ApiOperation({ summary: 'Readiness: the database is reachable (route traffic here)' })
  @ApiResponse({ status: 200, description: 'ready' })
  @ApiResponse({ status: 503, description: 'not ready' })
  async readiness(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    if (report.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
