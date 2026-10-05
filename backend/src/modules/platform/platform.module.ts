import { Module } from '@nestjs/common';

import { DemoController, PlatformController } from './platform.controller.js';
import { PlatformService } from './platform.service.js';

@Module({
  controllers: [PlatformController, DemoController],
  providers: [PlatformService],
})
export class PlatformModule {}
