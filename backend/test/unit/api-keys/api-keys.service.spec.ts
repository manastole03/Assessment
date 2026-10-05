import { ErrorCode } from '../../../src/common/constants/error-codes.js';
import { sha256Hex } from '../../../src/common/utils/crypto.util.js';
import { Role, UserStatus } from '../../../src/generated/prisma/enums.js';
import type {
  ApiKeyWithOwner,
  ApiKeysRepository,
} from '../../../src/modules/api-keys/api-keys.repository.js';
import { ApiKeysService } from '../../../src/modules/api-keys/api-keys.service.js';
import type { AuditService } from '../../../src/modules/audit/audit.service.js';
import { actor, mockOf } from '../../helpers/fixtures.js';

const SECRET = `rote_0a1b2c3d_${'A'.repeat(43)}`;

function keyRow(overrides: Partial<ApiKeyWithOwner> = {}): ApiKeyWithOwner {
  return {
    id: 'key-1',
    userId: 'user-1',
    name: 'agent',
    prefix: 'rote_0a1b2c3d',
    keyHash: sha256Hex(SECRET),
    role: Role.OPERATOR,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    user: {
      id: 'user-1',
      email: 'dana@example.com',
      name: 'Dana',
      role: Role.REVIEWER,
      status: UserStatus.ACTIVE,
    },
    ...overrides,
  };
}

function setup() {
  const keys = mockOf<ApiKeysRepository>();
  const audit = mockOf<AuditService>();
  return { service: new ApiKeysService(keys, audit), keys, audit };
}

async function errorCode(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('ApiKeysService', () => {
  it('issues a key once, storing only its hash', async () => {
    const { service, keys } = setup();
    keys.create.mockImplementation(async (data) =>
      keyRow({ prefix: data.prefix, keyHash: data.keyHash, role: data.role }),
    );
    const { secret, apiKey } = await service.create(actor(Role.REVIEWER), {
      name: 'agent',
      role: Role.OPERATOR,
    });
    expect(secret).toMatch(/^rote_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(secret.startsWith(apiKey.prefix)).toBe(true);
    const stored = keys.create.mock.calls[0]?.[0];
    expect(stored?.keyHash).toBe(sha256Hex(secret));
    expect(JSON.stringify(stored)).not.toContain(secret.slice(-20));
  });

  it('never grants a key more than its creator has', async () => {
    const { service } = setup();
    expect(
      await errorCode(service.create(actor(Role.OPERATOR), { name: 'x', role: Role.ADMIN })),
    ).toBe(ErrorCode.ROLE_EXCEEDS_OWNER);
    expect(
      await errorCode(
        service.create(actor(Role.ADMIN, { authMethod: 'api_key' }), {
          name: 'x',
          role: Role.VIEWER,
        }),
      ),
    ).toBe(ErrorCode.FORBIDDEN);
  });

  it('authenticates a valid key as its owner, capped at the key role', async () => {
    const { service, keys } = setup();
    keys.findByPrefix.mockResolvedValue(keyRow());
    expect(await service.authenticate(SECRET)).toMatchObject({
      id: 'user-1',
      role: Role.OPERATOR,
      authMethod: 'api_key',
      apiKeyId: 'key-1',
    });
    expect(keys.touch).toHaveBeenCalled();
  });

  it('caps the key at the owner’s current role when the owner was demoted', async () => {
    const { service, keys } = setup();
    keys.findByPrefix.mockResolvedValue(
      keyRow({ role: Role.REVIEWER, user: { ...keyRow().user, role: Role.VIEWER } }),
    );
    expect((await service.authenticate(SECRET))?.role).toBe(Role.VIEWER);
  });

  it('rejects malformed, wrong, revoked, expired and orphaned keys', async () => {
    const { service, keys } = setup();
    expect(await service.authenticate('not-a-key')).toBeNull();
    expect(keys.findByPrefix).not.toHaveBeenCalled();

    keys.findByPrefix.mockResolvedValue(keyRow({ keyHash: sha256Hex('something else') }));
    expect(await service.authenticate(SECRET)).toBeNull();
    keys.findByPrefix.mockResolvedValue(keyRow({ revokedAt: new Date() }));
    expect(await service.authenticate(SECRET)).toBeNull();
    keys.findByPrefix.mockResolvedValue(keyRow({ expiresAt: new Date(Date.now() - 1000) }));
    expect(await service.authenticate(SECRET)).toBeNull();
    keys.findByPrefix.mockResolvedValue(
      keyRow({ user: { ...keyRow().user, status: UserStatus.DISABLED } }),
    );
    expect(await service.authenticate(SECRET)).toBeNull();
  });

  it('lets owners and admins revoke, and hides other people’s keys from everyone else', async () => {
    const { service, keys } = setup();
    keys.findById.mockResolvedValue(keyRow());
    expect(
      await errorCode(service.revoke(actor(Role.REVIEWER, { id: 'someone-else' }), 'key-1')),
    ).toBe(ErrorCode.API_KEY_NOT_FOUND);
    await service.revoke(actor(Role.ADMIN, { id: 'admin' }), 'key-1');
    expect(keys.revoke).toHaveBeenCalledWith('key-1');
  });

  it('only lets admins list other users’ keys', async () => {
    const { service, keys } = setup();
    keys.findPage.mockResolvedValue([[], 0]);
    const query = { page: 1, limit: 20, all: true };
    expect(await errorCode(service.list(actor(Role.REVIEWER), query))).toBe(
      ErrorCode.INSUFFICIENT_ROLE,
    );
    await service.list(actor(Role.ADMIN), query);
    expect(keys.findPage).toHaveBeenCalledWith(
      { userId: undefined, includeRevoked: false },
      { page: 1, limit: 20 },
    );
  });
});
