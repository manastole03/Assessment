import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { ErrorCode } from '../../common/constants/error-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import type {
  AuthenticatedUser,
  AuthMethod,
} from '../../common/interfaces/authenticated-user.interface.js';
import { sha256Hex } from '../../common/utils/crypto.util.js';
import { currentRequestContext } from '../../common/utils/request-context.js';
import { normalizeEmail } from '../../common/utils/strings.util.js';
import { appConfig } from '../../config/configuration.js';
import type { User } from '../../generated/prisma/client.js';
import { AuditOutcome, Role, UserStatus } from '../../generated/prisma/enums.js';
import { AuditAction } from '../audit/audit.constants.js';
import { AuditService } from '../audit/audit.service.js';
import { toUserEntity } from '../users/entities/user.entity.js';
import { PasswordService } from '../users/password.service.js';
import { UsersRepository } from '../users/users.repository.js';
import { UsersService } from '../users/users.service.js';
import type {
  AuthSessionDto,
  ChangePasswordDto,
  IdentityDto,
  LoginDto,
  RegisterDto,
} from './dto/auth.dto.js';
import type { IssuedSession, JwtPayload } from './interfaces/jwt-payload.interface.js';
import { SessionsRepository } from './sessions.repository.js';
import { TokenService } from './token.service.js';

/** One message for every sign-in failure, so responses never reveal whether an account exists. */
const INVALID_LOGIN = 'Invalid email or password, or the account is temporarily locked';

export interface SignInResult {
  body: AuthSessionDto;
  session: IssuedSession;
  sessionId: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly usersService: UsersService,
    private readonly sessions: SessionsRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
  ) {}

  /** Self-service sign-up, when enabled. New accounts are VIEWERs; an admin grants more. */
  async register(dto: RegisterDto): Promise<SignInResult> {
    if (!this.config.auth.allowSignup) {
      throw AppException.forbidden(
        'Sign-up is disabled; ask an administrator for an account',
        ErrorCode.SIGNUP_DISABLED,
      );
    }
    const user = await this.usersService.createUser({ ...dto, role: Role.VIEWER });
    await this.audit.record({
      actor: { email: user.email },
      action: AuditAction.AUTH_REGISTER,
      resourceType: 'user',
      resourceId: user.id,
    });
    return this.startSession(user);
  }

  /**
   * Password sign-in. Unknown emails, wrong passwords, disabled and locked accounts all get the same
   * answer after the same amount of work. Repeated failures lock the account for a while.
   */
  async login(dto: LoginDto): Promise<SignInResult> {
    const email = normalizeEmail(dto.email);
    const user = await this.users.findByEmail(email);
    const now = new Date();

    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      (user.lockedUntil && user.lockedUntil > now)
    ) {
      await this.passwords.verifyAgainstDummy(dto.password);
      await this.recordFailedLogin(
        email,
        user,
        !user ? 'unknown_email' : user.status !== UserStatus.ACTIVE ? 'disabled' : 'locked',
      );
      throw AppException.unauthorized(INVALID_LOGIN, ErrorCode.INVALID_CREDENTIALS);
    }

    if (!(await this.passwords.verify(user.passwordHash, dto.password))) {
      const lockUntil = new Date(now.getTime() + this.config.auth.lockoutMinutes * 60_000);
      const updated = await this.users.recordLoginFailure(
        user.id,
        this.config.auth.maxFailedLogins,
        lockUntil,
      );
      await this.recordFailedLogin(
        email,
        user,
        updated.lockedUntil ? 'locked_now' : 'bad_password',
      );
      throw AppException.unauthorized(INVALID_LOGIN, ErrorCode.INVALID_CREDENTIALS);
    }

    // Upgrade the stored hash transparently when the hashing parameters have been raised.
    const rehash = this.passwords.needsRehash(user.passwordHash)
      ? await this.passwords.hash(dto.password)
      : undefined;
    const signedIn = await this.users.recordLoginSuccess(user.id, rehash);
    const result = await this.startSession(signedIn);
    await this.audit.record({
      actor: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        authMethod: 'session',
      },
      action: AuditAction.AUTH_LOGIN,
      resourceType: 'session',
      resourceId: result.sessionId,
    });
    return result;
  }

  /**
   * Exchange a refresh token for a new pair (rotation). Presenting a token that was already rotated
   * means it leaked: the whole session is revoked and the caller must sign in again.
   */
  async refresh(presented: string | undefined): Promise<SignInResult> {
    if (!presented)
      throw AppException.unauthorized('No refresh token', ErrorCode.INVALID_REFRESH_TOKEN);
    const presentedHash = sha256Hex(presented);
    const session = await this.sessions.findByRefreshHash(presentedHash);

    if (!session) {
      const reused = await this.sessions.findByPreviousHash(presentedHash);
      if (reused && !reused.revokedAt) {
        await this.sessions.revoke(reused.id, 'refresh_token_reuse');
        this.logger.warn(
          { sessionId: reused.id, userId: reused.userId },
          'Refresh token reuse: session revoked',
        );
        await this.audit.record({
          actor: null,
          action: AuditAction.AUTH_REFRESH_REUSED,
          resourceType: 'session',
          resourceId: reused.id,
          outcome: AuditOutcome.FAILURE,
          metadata: { userId: reused.userId },
        });
        throw AppException.unauthorized(
          'This session was revoked; sign in again',
          ErrorCode.REFRESH_TOKEN_REUSED,
        );
      }
      throw AppException.unauthorized('Invalid refresh token', ErrorCode.INVALID_REFRESH_TOKEN);
    }
    if (session.revokedAt || session.expiresAt <= new Date()) {
      throw AppException.unauthorized(
        'Your session has ended; sign in again',
        ErrorCode.SESSION_EXPIRED,
      );
    }
    if (session.user.status !== UserStatus.ACTIVE) {
      await this.sessions.revoke(session.id, 'user_disabled');
      throw AppException.unauthorized(
        'Your session has ended; sign in again',
        ErrorCode.SESSION_EXPIRED,
      );
    }

    const refreshToken = this.tokens.newRefreshToken();
    const refreshTokenExpiresAt = this.tokens.refreshExpiry();
    const rotated = await this.sessions.rotate(
      session.id,
      presentedHash,
      sha256Hex(refreshToken),
      refreshTokenExpiresAt,
    );
    if (!rotated)
      throw AppException.unauthorized('Invalid refresh token', ErrorCode.INVALID_REFRESH_TOKEN);

    return this.issue(session.user, session.id, refreshToken, refreshTokenExpiresAt);
  }

  /** End the session behind the refresh cookie and/or the current access token. Idempotent. */
  async logout(
    presentedRefresh: string | undefined,
    actor: AuthenticatedUser | undefined,
  ): Promise<void> {
    let sessionId = actor?.sessionId;
    if (!sessionId && presentedRefresh) {
      sessionId = (await this.sessions.findByRefreshHash(sha256Hex(presentedRefresh)))?.id;
    }
    if (!sessionId) return;
    await this.sessions.revoke(sessionId, 'logout');
    await this.audit.record({
      actor: actor ?? null,
      action: AuditAction.AUTH_LOGOUT,
      resourceType: 'session',
      resourceId: sessionId,
    });
  }

  /** Change your password; every other session of yours is signed out. */
  async changePassword(actor: AuthenticatedUser, dto: ChangePasswordDto): Promise<void> {
    if (actor.authMethod === 'api_key')
      throw AppException.forbidden('Sign in to change your password');
    const user = await this.users.findById(actor.id);
    if (!user) throw AppException.unauthorized();
    if (!(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
      throw AppException.badRequest(
        'Your current password is incorrect',
        ErrorCode.INVALID_PASSWORD,
      );
    }
    if (dto.currentPassword === dto.newPassword) {
      throw AppException.badRequest(
        'Choose a password different from the current one',
        ErrorCode.INVALID_PASSWORD,
      );
    }
    await this.users.update(user.id, { passwordHash: await this.passwords.hash(dto.newPassword) });
    const revoked = await this.sessions.revokeAllForUser(
      user.id,
      'password_changed',
      actor.sessionId,
    );
    await this.audit.record({
      actor,
      action: AuditAction.AUTH_PASSWORD_CHANGED,
      resourceType: 'user',
      resourceId: user.id,
      metadata: { otherSessionsRevoked: revoked },
    });
  }

  /**
   * Resolve a verified access token to the caller, from the database: the session must be live and
   * the user active. Returns null otherwise (the guard answers 401).
   */
  async authenticateAccessToken(
    payload: JwtPayload,
    method: AuthMethod,
  ): Promise<AuthenticatedUser | null> {
    if (payload.typ !== 'access' || !payload.sid || !payload.sub) return null;
    const session = await this.sessions.findWithUser(payload.sid);
    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt ||
      session.expiresAt <= new Date()
    )
      return null;
    if (session.user.status !== UserStatus.ACTIVE) return null;
    const { user } = session;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      authMethod: method,
      sessionId: session.id,
    };
  }

  async identity(actor: AuthenticatedUser): Promise<IdentityDto> {
    const user = await this.users.findById(actor.id);
    if (!user) throw AppException.unauthorized();
    return { user: toUserEntity(user), effectiveRole: actor.role, authMethod: actor.authMethod };
  }

  private async startSession(user: User): Promise<SignInResult> {
    const refreshToken = this.tokens.newRefreshToken();
    const refreshTokenExpiresAt = this.tokens.refreshExpiry();
    const context = currentRequestContext();
    const session = await this.sessions.create({
      userId: user.id,
      refreshTokenHash: sha256Hex(refreshToken),
      expiresAt: refreshTokenExpiresAt,
      userAgent: context?.userAgent ?? null,
      ipAddress: context?.ip ?? null,
    });
    return this.issue(user, session.id, refreshToken, refreshTokenExpiresAt);
  }

  private async issue(
    user: User,
    sessionId: string,
    refreshToken: string,
    refreshTokenExpiresAt: Date,
  ): Promise<SignInResult> {
    const access = await this.tokens.signAccessToken(user.id, sessionId);
    const session: IssuedSession = {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt,
      csrfToken: this.tokens.newCsrfToken(),
    };
    return {
      session,
      sessionId,
      body: {
        user: toUserEntity(user),
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
      },
    };
  }

  private async recordFailedLogin(email: string, user: User | null, reason: string): Promise<void> {
    await this.audit.record({
      actor: user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            authMethod: 'session',
          }
        : { email },
      action: AuditAction.AUTH_LOGIN_FAILED,
      resourceType: 'user',
      resourceId: user?.id,
      outcome: AuditOutcome.FAILURE,
      metadata: { reason },
    });
  }
}
