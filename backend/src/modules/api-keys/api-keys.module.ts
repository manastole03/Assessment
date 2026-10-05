import { Module } from '@nestjs/common';

import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysRepository } from './api-keys.repository.js';
import { ApiKeysService } from './api-keys.service.js';

@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysRepository, ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
