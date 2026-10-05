import type { ArgumentMetadata, Type } from '@nestjs/common';

import { createValidationPipe } from '../../../src/common/pipes/validation.pipe.js';
import { EngineIdPipe, EvidencePathPipe } from '../../../src/common/pipes/resource-id.pipe.js';
import { ListUsersQueryDto, CreateUserDto } from '../../../src/modules/users/dto/user.dto.js';
import { OperatorInputDto } from '../../../src/modules/runs/dto/operator.dto.js';
import { ListRunsQueryDto, StartRunDto } from '../../../src/modules/runs/dto/run.dto.js';

const pipe = createValidationPipe();

async function validate<T>(
  dto: Type<T>,
  value: unknown,
  type: ArgumentMetadata['type'] = 'body',
): Promise<T> {
  return (await pipe.transform(value, { type, metatype: dto })) as T;
}

async function fields(
  dto: Type<unknown>,
  value: unknown,
  type: ArgumentMetadata['type'] = 'body',
): Promise<string[]> {
  try {
    await validate(dto, value, type);
    return [];
  } catch (error) {
    const details = (error as { details?: { field: string }[] }).details ?? [];
    return details.map((detail) => detail.field);
  }
}

describe('request validation', () => {
  it('applies defaults and accepts a replay', async () => {
    const dto = await validate(StartRunDto, {
      kind: 'replay',
      tenant: 'acme',
      capability: 'legacycore.member.get_savings_balance@1.0.3',
      inputs: { member_id: '12345' },
    });
    expect(dto).toMatchObject({
      escalation: 'wait',
      allowDraft: false,
      maxTurns: 30,
      discoveryKind: 'task',
    });
  });

  it('requires what each kind of run needs', async () => {
    expect(await fields(StartRunDto, { kind: 'replay', tenant: 'acme' })).toContain('capability');
    expect(await fields(StartRunDto, { kind: 'discovery', tenant: 'acme' })).toContain('goal');
    expect(
      await fields(StartRunDto, {
        kind: 'discovery',
        tenant: 'acme',
        goal: 'Sign on to LegacyCore',
      }),
    ).toEqual([]);
  });

  it('rejects unknown properties, bad identifiers and oversized inputs', async () => {
    expect(
      await fields(StartRunDto, { kind: 'replay', tenant: 'acme', capability: 'x', admin: true }),
    ).toContain('admin');
    expect(
      await fields(StartRunDto, { kind: 'replay', tenant: '../etc', capability: 'x' }),
    ).toContain('tenant');
    expect(await fields(StartRunDto, { kind: 'teleport', tenant: 'acme' })).toContain('kind');
    const big = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    expect(
      await fields(StartRunDto, { kind: 'replay', tenant: 'acme', capability: 'x', inputs: big }),
    ).toContain('inputs');
    expect(
      await fields(StartRunDto, {
        kind: 'replay',
        tenant: 'acme',
        capability: 'x',
        inputs: { member_id: 12345 },
      }),
    ).toContain('inputs');
  });

  it('enforces the password policy', async () => {
    const user = { email: 'a@example.com', name: 'A' };
    expect(await fields(CreateUserDto, { ...user, password: 'short1' })).toContain('password');
    expect(await fields(CreateUserDto, { ...user, password: 'onlylettersherefolks' })).toContain(
      'password',
    );
    expect(await fields(CreateUserDto, { ...user, password: '123456789012345' })).toContain(
      'password',
    );
    expect(await fields(CreateUserDto, { ...user, password: 'correct horse battery 9' })).toEqual(
      [],
    );
  });

  it('coerces and bounds query strings, and only sorts by whitelisted fields', async () => {
    const query = await validate(
      ListUsersQueryDto,
      { page: '2', limit: '50', sortBy: 'email' },
      'query',
    );
    expect(query).toMatchObject({ page: 2, limit: 50, sortBy: 'email', sortOrder: 'desc' });
    expect(await fields(ListUsersQueryDto, { limit: '1000' }, 'query')).toContain('limit');
    expect(await fields(ListUsersQueryDto, { sortBy: 'passwordHash' }, 'query')).toContain(
      'sortBy',
    );
    expect(await fields(ListRunsQueryDto, { requestedBy: 'me', active: 'true' }, 'query')).toEqual(
      [],
    );
    expect(await fields(ListRunsQueryDto, { requestedBy: 'someone' }, 'query')).toContain(
      'requestedBy',
    );
  });

  it('requires the fields each operator input kind needs', async () => {
    expect(await fields(OperatorInputDto, { epoch: 1, kind: 'click', x: 10 })).toContain('y');
    expect(
      await fields(OperatorInputDto, { epoch: 1, kind: 'press', key: 'Enter; rm -rf' }),
    ).toContain('key');
    expect(await fields(OperatorInputDto, { epoch: 1, kind: 'type', text: 'hello' })).toEqual([]);
  });
});

describe('path parameter pipes', () => {
  it('accepts engine ids and refuses traversal', () => {
    const pipeForIds = new EngineIdPipe();
    expect(pipeForIds.transform('legacycore.member.get_savings_balance@1.0.3')).toBe(
      'legacycore.member.get_savings_balance@1.0.3',
    );
    expect(() => pipeForIds.transform('..')).toThrow();
    expect(() => pipeForIds.transform('a/b')).toThrow();
  });

  it('accepts relative evidence paths only', () => {
    const paths = new EvidencePathPipe();
    expect(paths.transform(['screens', '0010-s02-fill.jpg'])).toBe('screens/0010-s02-fill.jpg');
    expect(() => paths.transform(['..', 'etc', 'passwd'])).toThrow();
    expect(() => paths.transform('/etc/passwd')).toThrow();
  });
});
