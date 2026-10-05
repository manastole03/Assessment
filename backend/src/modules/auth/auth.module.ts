import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { appConfig } from '../../config/configuration.js';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { SessionCleanupService } from './session-cleanup.service.js';
import { SessionsRepository } from './sessions.repository.js';
import { ApiKeyStrategy } from './strategies/api-key.strategy.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [
    UsersModule,
    ApiKeysModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [appConfig.KEY],
      useFactory: (config: ConfigType<typeof appConfig>) => ({
        secret: config.auth.jwtSecret,
        signOptions: {
          algorithm: 'HS256',
          issuer: config.auth.jwtIssuer,
          audience: config.auth.jwtAudience,
        },
        verifyOptions: {
          algorithms: ['HS256'],
          issuer: config.auth.jwtIssuer,
          audience: config.auth.jwtAudience,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    SessionsRepository,
    SessionCleanupService,
    JwtStrategy,
    ApiKeyStrategy,
    JwtAuthGuard,
  ],
  exports: [JwtAuthGuard, AuthService],
})
export class AuthModule {}
