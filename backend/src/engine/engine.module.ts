import { Global, Module } from '@nestjs/common';

import { EngineProxyService } from './engine-proxy.service.js';
import { EngineClient } from './engine.client.js';

/** The engine gateway, shared by every feature module that reads or drives the engine. */
@Global()
@Module({
  providers: [EngineClient, EngineProxyService],
  exports: [EngineClient, EngineProxyService],
})
export class EngineModule {}
