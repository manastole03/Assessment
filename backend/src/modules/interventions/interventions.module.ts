import { Module } from '@nestjs/common';

import { InterventionsController } from './interventions.controller.js';
import { InterventionsRepository } from './interventions.repository.js';
import { InterventionsService } from './interventions.service.js';

@Module({
  controllers: [InterventionsController],
  providers: [InterventionsRepository, InterventionsService],
  exports: [InterventionsRepository],
})
export class InterventionsModule {}
