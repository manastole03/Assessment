import { Module } from '@nestjs/common';

import { PasswordService } from './password.service.js';
import { UsersController } from './users.controller.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [UsersController],
  providers: [UsersRepository, UsersService, PasswordService],
  exports: [UsersService, UsersRepository, PasswordService],
})
export class UsersModule {}
