import { Module } from '@nestjs/common';

import { RunsModule } from '../runs/runs.module.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { McpController } from './mcp.controller.js';

@Module({
  imports: [RunsModule],
  controllers: [AgentsController, McpController],
  providers: [AgentsService],
})
export class AgentsModule {}
