import { ErrorCode } from '../../../src/common/constants/error-codes.js';
import { sha256Hex } from '../../../src/common/utils/crypto.util.js';
import { Role, UserStatus } from '../../../src/generated/prisma/enums.js';
import type { AuditService } from '../../../src/modules/audit/audit.service.js';
import { AuthService } from '../../../src/modules/auth/auth.service.js';
import type { SessionsRepository } from '../../../src/modules/auth/sessions.repository.js';
import type { TokenService } from '../../../src/modules/auth/token.service.js';
import type { PasswordService } from '../../../src/modules/users/password.service.js';
import type { UsersRepository } from '../../../src/modules/users/users.repository.js';
import type { UsersService } from '../../../src/modules/users/users.service.js';
import { actor, mockOf, testConfig, userRow } from '../../helpers/fixtures.js';

const FUTURE = new Date(Date.now() + 86_400_000);

function setup(config = testConfig()) {
  const users = mockOf<UsersRepository>();
  const usersService = mockOf<UsersService>();
  const sessions = mockOf<SessionsRepository>();
  const passwords = mockOf<PasswordService>();
  const tokens = mockOf<TokenService>();
  const audit = mockOf<AuditService>();
  tokens.newRefreshToken.mockReturnValue('refresh-token');
  tokens.newCsrfToken.mockReturnValue('csrf-token');
  tokens.refreshExpiry.mockReturnValue(FUTURE);
  tokens.signAccessToken.mockResolvedValue({ token: 'jwt', expiresAt: FUTURE });
  sessions.create.mockResolvedValue({ id: 'session-1' } as never);
  passwords.needsRehash.mockReturnValue(false);
  const service = new AuthService(users, usersService, sessions, passwords, tokens, audit, config);
  return { service, users, usersService, sessions, passwords, tokens, audit };
}

async function errorCode(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('AuthService.login', () => {
  it('signs in, resets failures and issues a session', async () => {
    const { service, users, passwords, sessions, audit } = setup();
    const user = userRow();
    users.findByEmail.mockResolvedValue(user);
    passwords.verify.mockResolvedValue(true);
    users.recordLoginSuccess.mockResolvedValue(user);

    const result = await service.login({
      email: '  Dana@Example.com ',
      password: 'correct horse battery 9',
    });

    expect(users.findByEmail).toHaveBeenCalledWith('dana@example.com');
    expect(users.recordLoginSuccess).toHaveBeenCalledWith(user.id, undefined);
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.id, refreshTokenHash: sha256Hex('refresh-token') }),
    );
    expect(result.body).toMatchObject({ accessToken: 'jwt', user: { email: user.email } });
    expect(result.body.user).not.toHaveProperty('passwordHash');
    expect(result.session).toMatchObject({
      refreshToken: 'refresh-token',
      csrfToken: 'csrf-token',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login', resourceId: 'session-1' }),
    );
  });

  it('gives an unknown email the same answer, after the same work', async () => {
    const { service, users, passwords, audit } = setup();
    users.findByEmail.mockResolvedValue(null);
    expect(
      await errorCode(service.login({ email: 'nobody@example.com', password: 'whatever' })),
    ).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(passwords.verifyAgainstDummy).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.login_failed',
        metadata: { reason: 'unknown_email' },
      }),
    );
  });

  it('counts a wrong password and locks the account at the limit', async () => {
    const { service, users, passwords } = setup(
      testConfig({ auth: { maxFailedLogins: 3, lockoutMinutes: 10 } }),
    );
    const user = userRow();
    users.findByEmail.mockResolvedValue(user);
    passwords.verify.mockResolvedValue(false);
    users.recordLoginFailure.mockResolvedValue({ ...user, lockedUntil: FUTURE });

    expect(await errorCode(service.login({ email: user.email, password: 'wrong' }))).toBe(
      ErrorCode.INVALID_CREDENTIALS,
    );
    const [id, max, until] = users.recordLoginFailure.mock.calls[0] as [string, number, Date];
    expect([id, max]).toEqual([user.id, 3]);
    expect(until.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
  });

  it('refuses locked and disabled accounts without checking the password', async () => {
    for (const user of [
      userRow({ lockedUntil: FUTURE }),
      userRow({ status: UserStatus.DISABLED }),
    ]) {
      const { service, users, passwords } = setup();
      users.findByEmail.mockResolvedValue(user);
      expect(
        await errorCode(service.login({ email: user.email, password: 'correct horse battery 9' })),
      ).toBe(ErrorCode.INVALID_CREDENTIALS);
      expect(passwords.verify).not.toHaveBeenCalled();
    }
  });

  it('upgrades an outdated password hash on sign-in', async () => {
    const { service, users, passwords } = setup();
    users.findByEmail.mockResolvedValue(userRow());
    passwords.verify.mockResolvedValue(true);
    passwords.needsRehash.mockReturnValue(true);
    passwords.hash.mockResolvedValue('new-hash');
    users.recordLoginSuccess.mockResolvedValue(userRow());
    await service.login({ email: 'dana@example.com', password: 'correct horse battery 9' });
    expect(users.recordLoginSuccess).toHaveBeenCalledWith(expect.any(String), 'new-hash');
  });
});

describe('AuthService.refresh', () => {
  const liveSession = () => ({
    id: 'session-1',
    userId: 'user-1',
    revokedAt: null,
    expiresAt: FUTURE,
    user: userRow({ id: 'user-1' }),
  });

  it('rotates the refresh token', async () => {
    const { service, sessions } = setup();
    sessions.findByRefreshHash.mockResolvedValue(liveSession() as never);
    sessions.rotate.mockResolvedValue(true);
    const result = await service.refresh('old-token');
    expect(sessions.rotate).toHaveBeenCalledWith(
      'session-1',
      sha256Hex('old-token'),
      sha256Hex('refresh-token'),
      FUTURE,
    );
    expect(result.session.refreshToken).toBe('refresh-token');
  });

  it('revokes the whole session when a rotated token is replayed', async () => {
    const { service, sessions, audit } = setup();
    sessions.findByRefreshHash.mockResolvedValue(null);
    sessions.findByPreviousHash.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      revokedAt: null,
    } as never);
    expect(await errorCode(service.refresh('stolen-token'))).toBe(ErrorCode.REFRESH_TOKEN_REUSED);
    expect(sessions.revoke).toHaveBeenCalledWith('session-1', 'refresh_token_reuse');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.refresh_token_reused' }),
    );
  });

  it('rejects missing, unknown, expired and race-losing tokens', async () => {
    const { service, sessions } = setup();
    expect(await errorCode(service.refresh(undefined))).toBe(ErrorCode.INVALID_REFRESH_TOKEN);

    sessions.findByRefreshHash.mockResolvedValue(null);
    sessions.findByPreviousHash.mockResolvedValue(null);
    expect(await errorCode(service.refresh('nope'))).toBe(ErrorCode.INVALID_REFRESH_TOKEN);

    sessions.findByRefreshHash.mockResolvedValue({
      ...liveSession(),
      expiresAt: new Date(0),
    } as never);
    expect(await errorCode(service.refresh('old'))).toBe(ErrorCode.SESSION_EXPIRED);

    sessions.findByRefreshHash.mockResolvedValue(liveSession() as never);
    sessions.rotate.mockResolvedValue(false);
    expect(await errorCode(service.refresh('old'))).toBe(ErrorCode.INVALID_REFRESH_TOKEN);
  });
});

describe('AuthService access tokens and accounts', () => {
  it('accepts a token only while its session is live and its user active', async () => {
    const { service, sessions } = setup();
    const payload = { sub: 'user-1', sid: 'session-1', typ: 'access' as const };
    const session = {
      id: 'session-1',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: FUTURE,
      user: userRow({ id: 'user-1', role: Role.REVIEWER }),
    };

    sessions.findWithUser.mockResolvedValue(session as never);
    expect(await service.authenticateAccessToken(payload, 'session')).toMatchObject({
      id: 'user-1',
      role: Role.REVIEWER,
      sessionId: 'session-1',
    });

    sessions.findWithUser.mockResolvedValue({ ...session, revokedAt: new Date() } as never);
    expect(await service.authenticateAccessToken(payload, 'session')).toBeNull();

    sessions.findWithUser.mockResolvedValue({
      ...session,
      user: userRow({ status: UserStatus.DISABLED }),
    } as never);
    expect(await service.authenticateAccessToken(payload, 'session')).toBeNull();

    sessions.findWithUser.mockResolvedValue({ ...session, userId: 'someone-else' } as never);
    expect(await service.authenticateAccessToken(payload, 'session')).toBeNull();
  });

  it('refuses sign-up when it is disabled', async () => {
    const { service, usersService } = setup(testConfig({ auth: { allowSignup: false } }));
    expect(
      await errorCode(
        service.register({
          email: 'a@example.com',
          name: 'A',
          password: 'correct horse battery 9',
        }),
      ),
    ).toBe(ErrorCode.SIGNUP_DISABLED);
    expect(usersService.createUser).not.toHaveBeenCalled();
  });

  it('signs up as a VIEWER when enabled', async () => {
    const { service, usersService } = setup(testConfig({ auth: { allowSignup: true } }));
    usersService.createUser.mockResolvedValue(userRow({ role: Role.VIEWER }));
    await service.register({
      email: 'a@example.com',
      name: 'A',
      password: 'correct horse battery 9',
    });
    expect(usersService.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ role: Role.VIEWER }),
    );
  });

  it('changes a password only with the current one, and signs out other sessions', async () => {
    const { service, users, passwords, sessions } = setup();
    users.findById.mockResolvedValue(userRow());
    passwords.verify.mockResolvedValue(false);
    const me = actor(Role.OPERATOR, { id: userRow().id });
    expect(
      await errorCode(
        service.changePassword(me, {
          currentPassword: 'x',
          newPassword: 'correct horse battery 9',
        }),
      ),
    ).toBe(ErrorCode.INVALID_PASSWORD);

    passwords.verify.mockResolvedValue(true);
    passwords.hash.mockResolvedValue('new-hash');
    sessions.revokeAllForUser.mockResolvedValue(2);
    await service.changePassword(me, {
      currentPassword: 'old password 1',
      newPassword: 'correct horse battery 9',
    });
    expect(users.update).toHaveBeenCalledWith(me.id, { passwordHash: 'new-hash' });
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(me.id, 'password_changed', me.sessionId);
  });

  it('does not let an API key change its owner’s password', async () => {
    const { service } = setup();
    const viaKey = actor(Role.OPERATOR, { authMethod: 'api_key' });
    expect(
      await errorCode(
        service.changePassword(viaKey, {
          currentPassword: 'a',
          newPassword: 'correct horse battery 9',
        }),
      ),
    ).toBe(ErrorCode.FORBIDDEN);
  });
});
