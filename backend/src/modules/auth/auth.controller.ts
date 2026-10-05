import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { REFRESH_TOKEN_COOKIE } from '../../common/constants/http.js';
import { ApiAuth, ApiEnvelope, ApiErrors } from '../../common/decorators/api-docs.decorators.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import {
  OptionalAuth,
  Public,
  ResponseMessage,
  SkipCsrf,
} from '../../common/decorators/metadata.decorators.js';
import type {
  AppRequest,
  AuthenticatedUser,
} from '../../common/interfaces/authenticated-user.interface.js';
import { appConfig } from '../../config/configuration.js';
import { clearSessionCookies, setSessionCookies } from './auth.cookies.js';
import { AuthService, type SignInResult } from './auth.service.js';
import {
  AuthOptionsDto,
  AuthSessionDto,
  ChangePasswordDto,
  IdentityDto,
  LoginDto,
  RegisterDto,
} from './dto/auth.dto.js';
import { AuthRateLimit } from './guards/auth-rate-limit.decorator.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
  ) {}

  @Get('options')
  @Public()
  @ApiOperation({ summary: 'What the sign-in page should offer' })
  @ApiEnvelope(AuthOptionsDto)
  options(): AuthOptionsDto {
    return {
      signupEnabled: this.config.auth.allowSignup,
      demoEnabled: this.config.features.demoEnabled,
    };
  }

  @Post('register')
  @Public()
  @SkipCsrf()
  @AuthRateLimit()
  @ResponseMessage('Account created')
  @ApiOperation({
    summary: 'Create an account (when sign-up is enabled); new accounts are VIEWERs',
  })
  @ApiEnvelope(AuthSessionDto, { status: HttpStatus.CREATED })
  @ApiErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.TOO_MANY_REQUESTS,
  )
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionDto> {
    return this.withCookies(res, await this.auth.register(dto));
  }

  @Post('login')
  @Public()
  @SkipCsrf()
  @AuthRateLimit()
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Signed in')
  @ApiOperation({
    summary: 'Sign in with email and password',
    description:
      'Sets httpOnly session cookies (browsers) and returns a short-lived access token (API clients). ' +
      'Every failure, including a locked account, returns the same INVALID_CREDENTIALS error.',
  })
  @ApiEnvelope(AuthSessionDto)
  @ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.TOO_MANY_REQUESTS)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionDto> {
    return this.withCookies(res, await this.auth.login(dto));
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Session refreshed')
  @ApiOperation({
    summary: 'Rotate the refresh cookie and get a new access token',
    description:
      'Requires the X-CSRF-Token header. Re-using an old refresh token revokes the whole session.',
  })
  @ApiEnvelope(AuthSessionDto)
  @ApiErrors(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  async refresh(
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionDto> {
    try {
      return this.withCookies(res, await this.auth.refresh(this.refreshCookie(req)));
    } catch (error) {
      clearSessionCookies(res, this.config.auth.cookieSecure);
      throw error;
    }
  }

  @Post('logout')
  @OptionalAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out: revoke the session and clear its cookies',
    description:
      'Revokes the session behind the access token (cookie or `Authorization: Bearer`) or, if that has ' +
      'expired, behind the refresh cookie. Idempotent: always 204.',
  })
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(this.refreshCookie(req), req.user);
    clearSessionCookies(res, this.config.auth.cookieSecure);
  }

  @Get('me')
  @ApiAuth()
  @ApiOperation({ summary: 'Who you are, and the role this request acts with' })
  @ApiEnvelope(IdentityDto)
  me(@CurrentUser() actor: AuthenticatedUser): Promise<IdentityDto> {
    return this.auth.identity(actor);
  }

  @Post('password')
  @ApiAuth()
  @AuthRateLimit()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change your password (signs out your other sessions)' })
  @ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.TOO_MANY_REQUESTS)
  async changePassword(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(actor, dto);
  }

  private withCookies(res: Response, result: SignInResult): AuthSessionDto {
    setSessionCookies(res, result.session, this.config.auth.cookieSecure);
    return result.body;
  }

  private refreshCookie(req: AppRequest): string | undefined {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    return cookies?.[REFRESH_TOKEN_COOKIE];
  }
}
