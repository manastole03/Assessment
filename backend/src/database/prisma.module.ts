import { Global, Module } from '@nestjs/common';

import { JobLeaseRepository } from './job-lease.repository.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService, JobLeaseRepository],
  exports: [PrismaService, JobLeaseRepository],
})
export class PrismaModule {}
