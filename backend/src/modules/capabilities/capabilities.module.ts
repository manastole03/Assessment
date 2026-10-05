import { Module } from '@nestjs/common';

import { RunsModule } from '../runs/runs.module.js';
import { CapabilitiesController } from './capabilities.controller.js';
import { CapabilitiesService } from './capabilities.service.js';
import { CapabilityApprovalsRepository } from './capability-approvals.repository.js';

@Module({
  imports: [RunsModule],
  controllers: [CapabilitiesController],
  providers: [CapabilitiesService, CapabilityApprovalsRepository],
})
export class CapabilitiesModule {}
