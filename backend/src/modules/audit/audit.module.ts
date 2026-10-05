import { Global, Module } from '@nestjs/common';

import { AuditController } from './audit.controller.js';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';

/** Global: every feature module records into the same audit trail. */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditRepository, AuditService],
  exports: [AuditService],
})
export class AuditModule {}
