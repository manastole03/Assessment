import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Role } from '../../common/constants/roles.js';
import {
  ApiAuth,
  ApiEnvelope,
  ApiErrors,
  ApiPaginatedEnvelope,
} from '../../common/decorators/api-docs.decorators.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { MinRole, ResponseMessage } from '../../common/decorators/metadata.decorators.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import type { PaginatedResult } from '../../common/utils/pagination.util.js';
import {
  CreateUserDto,
  ListUsersQueryDto,
  UpdateProfileDto,
  UpdateUserDto,
} from './dto/user.dto.js';
import { UserEntity } from './entities/user.entity.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@ApiAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @MinRole(Role.ADMIN)
  @ApiOperation({
    summary: 'List users (admins)',
    description: 'Search by email or name; filter by role and status.',
  })
  @ApiPaginatedEnvelope(UserEntity)
  @ApiErrors(HttpStatus.BAD_REQUEST)
  list(@Query() query: ListUsersQueryDto): Promise<PaginatedResult<UserEntity>> {
    return this.users.list(query);
  }

  @Post()
  @MinRole(Role.ADMIN)
  @ResponseMessage('User created')
  @ApiOperation({ summary: 'Create a user with a role (admins)' })
  @ApiEnvelope(UserEntity, { status: HttpStatus.CREATED, description: 'User created' })
  @ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.CONFLICT)
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateUserDto): Promise<UserEntity> {
    return this.users.create(actor, dto);
  }

  @Get('me')
  @ApiOperation({ summary: 'Your own user record' })
  @ApiEnvelope(UserEntity)
  me(@CurrentUser() actor: AuthenticatedUser): Promise<UserEntity> {
    return this.users.getSelf(actor);
  }

  @Patch('me')
  @ResponseMessage('Profile updated')
  @ApiOperation({ summary: 'Update your display name' })
  @ApiEnvelope(UserEntity)
  @ApiErrors(HttpStatus.BAD_REQUEST)
  updateMe(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserEntity> {
    return this.users.updateProfile(actor, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One user (admins; anyone for themselves)' })
  @ApiEnvelope(UserEntity)
  @ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.NOT_FOUND)
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UserEntity> {
    return this.users.getById(actor, id);
  }

  @Patch(':id')
  @MinRole(Role.ADMIN)
  @ResponseMessage('User updated')
  @ApiOperation({
    summary: 'Change a user’s name, role or status (admins)',
    description:
      'Admins cannot change their own role or status, and the last active admin cannot be demoted or disabled.',
  })
  @ApiEnvelope(UserEntity)
  @ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.NOT_FOUND, HttpStatus.CONFLICT)
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserEntity> {
    return this.users.update(actor, id, dto);
  }

  @Delete(':id')
  @MinRole(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a user (admins)' })
  @ApiErrors(HttpStatus.NOT_FOUND, HttpStatus.CONFLICT)
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.users.delete(actor, id);
  }
}
