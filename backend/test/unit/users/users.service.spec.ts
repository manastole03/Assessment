import { ErrorCode } from '../../../src/common/constants/error-codes.js';
import type { TransactionClient } from '../../../src/database/prisma.types.js';
import { Role, UserStatus } from '../../../src/generated/prisma/enums.js';
import type { AuditService } from '../../../src/modules/audit/audit.service.js';
import type { PasswordService } from '../../../src/modules/users/password.service.js';
import type { UsersRepository } from '../../../src/modules/users/users.repository.js';
import { UsersService } from '../../../src/modules/users/users.service.js';
import { actor, mockOf, userRow } from '../../helpers/fixtures.js';

function setup() {
  const users = mockOf<UsersRepository>();
  const passwords = mockOf<PasswordService>();
  const audit = mockOf<AuditService>();
  // Run "transactions" inline: the invariants are what is under test here.
  users.transaction.mockImplementation(async (work) => work({} as TransactionClient));
  return { service: new UsersService(users, passwords, audit), users, passwords, audit };
}

async function errorCode(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

const admin = actor(Role.ADMIN, { id: 'admin-1' });

describe('UsersService', () => {
  it('hashes the password, normalises the email and hides the hash', async () => {
    const { service, users, passwords } = setup();
    passwords.hash.mockResolvedValue('hashed');
    users.create.mockResolvedValue(userRow({ email: 'new@example.com', role: Role.REVIEWER }));
    const created = await service.create(admin, {
      email: ' New@Example.com',
      name: ' New ',
      password: 'correct horse battery 9',
      role: Role.REVIEWER,
    });
    expect(users.create).toHaveBeenCalledWith({
      email: 'new@example.com',
      name: 'New',
      role: Role.REVIEWER,
      passwordHash: 'hashed',
    });
    expect(created).not.toHaveProperty('passwordHash');
  });

  it('reports a duplicate email as a conflict', async () => {
    const { service, users, passwords } = setup();
    passwords.hash.mockResolvedValue('hashed');
    users.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['email'] },
      }),
    );
    expect(
      await errorCode(
        service.create(admin, {
          email: 'dup@example.com',
          name: 'D',
          password: 'correct horse battery 9',
          role: Role.VIEWER,
        }),
      ),
    ).toBe(ErrorCode.EMAIL_ALREADY_EXISTS);
  });

  it('hides other users from non-admins', async () => {
    const { service, users } = setup();
    users.findById.mockResolvedValue(userRow({ id: 'other' }));
    expect(await errorCode(service.getById(actor(Role.REVIEWER, { id: 'me' }), 'other'))).toBe(
      ErrorCode.USER_NOT_FOUND,
    );
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('does not let admins change their own role or status', async () => {
    const { service, users } = setup();
    expect(await errorCode(service.update(admin, admin.id, { role: Role.VIEWER }))).toBe(
      ErrorCode.SELF_MODIFICATION_FORBIDDEN,
    );
    expect(users.transaction).not.toHaveBeenCalled();
  });

  it('never leaves the system without an active admin', async () => {
    const { service, users } = setup();
    users.findById.mockResolvedValue(userRow({ id: 'admin-2', role: Role.ADMIN }));
    users.countActiveAdmins.mockResolvedValue(0);
    expect(await errorCode(service.update(admin, 'admin-2', { status: UserStatus.DISABLED }))).toBe(
      ErrorCode.LAST_ADMIN,
    );
    expect(await errorCode(service.delete(admin, 'admin-2'))).toBe(ErrorCode.LAST_ADMIN);
    expect(users.update).not.toHaveBeenCalled();
    expect(users.delete).not.toHaveBeenCalled();
  });

  it('audits role changes with before and after', async () => {
    const { service, users, audit } = setup();
    users.findById.mockResolvedValue(userRow({ id: 'u2', role: Role.VIEWER }));
    users.update.mockResolvedValue(userRow({ id: 'u2', role: Role.OPERATOR }));
    await service.update(admin, 'u2', { role: Role.OPERATOR });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.updated',
        resourceId: 'u2',
        metadata: { role: { from: 'VIEWER', to: 'OPERATOR' } },
      }),
    );
  });

  it('does not let admins delete themselves', async () => {
    const { service } = setup();
    expect(await errorCode(service.delete(admin, admin.id))).toBe(
      ErrorCode.SELF_MODIFICATION_FORBIDDEN,
    );
  });
});
