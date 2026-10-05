import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ApiAuth,
  ApiEnvelope,
  ApiErrors,
  ApiPaginatedEnvelope,
} from '../../common/decorators/api-docs.decorators.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseMessage } from '../../common/decorators/metadata.decorators.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import type { PaginatedResult } from '../../common/utils/pagination.util.js';
import { ApiKeysService } from './api-keys.service.js';
import {
  ApiKeyDto,
  CreateApiKeyDto,
  CreatedApiKeyDto,
  ListApiKeysQueryDto,
} from './dto/api-key.dto.js';

@ApiTags('api-keys')
@ApiAuth()
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @ApiOperation({ summary: 'Your API keys (admins: ?userId= or ?all=true)' })
  @ApiPaginatedEnvelope(ApiKeyDto)
  @ApiErrors(HttpStatus.BAD_REQUEST)
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListApiKeysQueryDto,
  ): Promise<PaginatedResult<ApiKeyDto>> {
    return this.keys.list(actor, query);
  }

  @Post()
  @ResponseMessage('API key created; copy the secret now, it is not shown again')
  @ApiOperation({
    summary: 'Create an API key for an agent or MCP client',
    description:
      'The response carries the secret once. Use it as `Authorization: Bearer <key>` (MCP clients) or `X-API-Key`.',
  })
  @ApiEnvelope(CreatedApiKeyDto, { status: HttpStatus.CREATED })
  @ApiErrors(HttpStatus.BAD_REQUEST)
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateApiKeyDto,
  ): Promise<CreatedApiKeyDto> {
    return this.keys.create(actor, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an API key (yours, or anyone’s for admins)' })
  @ApiErrors(HttpStatus.NOT_FOUND)
  async revoke(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.keys.revoke(actor, id);
  }
}
