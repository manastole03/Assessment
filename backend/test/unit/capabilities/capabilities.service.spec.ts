import { ErrorCode } from '../../../src/common/constants/error-codes.js';
import { Role } from '../../../src/common/constants/roles.js';
import type { EngineClient } from '../../../src/engine/engine.client.js';
import type { EngineCapabilityDetail } from '../../../src/engine/engine.types.js';
import type { AuditService } from '../../../src/modules/audit/audit.service.js';
import {
  CapabilitiesService,
  parseRef,
} from '../../../src/modules/capabilities/capabilities.service.js';
import type { CapabilityApprovalsRepository } from '../../../src/modules/capabilities/capability-approvals.repository.js';
import type { RunsRepository } from '../../../src/modules/runs/runs.repository.js';
import { actor, mockOf, testConfig } from '../../helpers/fixtures.js';

function detail(
  status: 'draft' | 'approved' | 'deprecated',
  sourceRun: string | null = 'run-1',
): EngineCapabilityDetail {
  return {
    summary: {
      id: 'legacycore.member.get_savings_balance',
      version: '1.0.4',
      title: 'Get savings balance',
      description: '',
      status,
      kind: 'task',
      versions: [],
      provenance: { source_run: sourceRun },
    },
  };
}

function setup(requireSeparateReviewer = true) {
  const engine = mockOf<EngineClient>();
  const approvals = mockOf<CapabilityApprovalsRepository>();
  const runs = mockOf<RunsRepository>();
  const audit = mockOf<AuditService>();
  const config = testConfig({ auth: { requireSeparateReviewer } });
  approvals.upsert.mockImplementation(async (data) => ({
    id: 'a1',
    capabilityId: data.capabilityId,
    version: data.version,
    approvedById: data.approvedById ?? null,
    reviewerEmail: data.reviewerEmail,
    reviewerName: data.reviewerName,
    notes: data.notes ?? null,
    createdAt: new Date(),
  }));
  return {
    service: new CapabilitiesService(engine, approvals, runs, audit, config),
    engine,
    approvals,
    runs,
  };
}

async function errorCode(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

const reviewer = actor(Role.REVIEWER, {
  id: 'reviewer-1',
  name: 'Riley',
  email: 'riley@example.com',
});

describe('CapabilitiesService.approve', () => {
  it('approves a draft as the signed-in reviewer and records it', async () => {
    const { service, engine, approvals, runs } = setup();
    engine.get.mockResolvedValue(detail('draft'));
    runs.findById.mockResolvedValue({ requestedById: 'someone-else' } as never);
    engine.post.mockResolvedValue({ ok: true, ref: 'x' });

    const approval = await service.approve(
      reviewer,
      'legacycore.member.get_savings_balance',
      'looks right',
    );

    expect(engine.post).toHaveBeenCalledWith(
      '/api/capabilities/legacycore.member.get_savings_balance%401.0.4/approve',
      expect.objectContaining({
        body: { reviewer: 'Riley <riley@example.com>', notes: 'looks right' },
      }),
    );
    expect(approvals.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ version: '1.0.4', approvedById: 'reviewer-1' }),
    );
    expect(approval).toMatchObject({
      ref: 'legacycore.member.get_savings_balance@1.0.4',
      approvedBy: { email: 'riley@example.com' },
    });
  });

  it('enforces four eyes: you cannot approve what your own run recorded', async () => {
    const { service, engine, runs } = setup();
    engine.get.mockResolvedValue(detail('draft'));
    runs.findById.mockResolvedValue({ requestedById: 'reviewer-1' } as never);
    expect(
      await errorCode(
        service.approve(reviewer, 'legacycore.member.get_savings_balance@1.0.4', undefined),
      ),
    ).toBe(ErrorCode.SELF_APPROVAL_FORBIDDEN);
    expect(engine.post).not.toHaveBeenCalled();
  });

  it('can be configured to allow self-approval', async () => {
    const { service, engine, runs } = setup(false);
    engine.get.mockResolvedValue(detail('draft'));
    runs.findById.mockResolvedValue({ requestedById: 'reviewer-1' } as never);
    engine.post.mockResolvedValue({ ok: true, ref: 'x' });
    await expect(
      service.approve(reviewer, 'legacycore.member.get_savings_balance', undefined),
    ).resolves.toBeDefined();
  });

  it('refuses approved and deprecated versions', async () => {
    for (const status of ['approved', 'deprecated'] as const) {
      const { service, engine } = setup();
      engine.get.mockResolvedValue(detail(status));
      expect(await errorCode(service.approve(reviewer, 'x', undefined))).toBe(
        ErrorCode.CAPABILITY_NOT_APPROVABLE,
      );
    }
  });

  it('splits refs', () => {
    expect(parseRef('a.b.c@1.2.3')).toEqual({ id: 'a.b.c', version: '1.2.3' });
    expect(parseRef('a.b.c')).toEqual({ id: 'a.b.c', version: undefined });
  });
});

describe('CapabilitiesService.list', () => {
  it('filters, searches and pages the engine’s library', async () => {
    const { service, engine } = setup();
    const cap = (id: string, status: string, kind: string) => ({
      ...detail('draft').summary,
      id,
      title: id,
      status,
      kind,
    });
    engine.get.mockResolvedValue([
      cap('legacycore.session.sign_on', 'approved', 'session'),
      cap('legacycore.member.balance', 'draft', 'task'),
      cap('legacycore.member.open_share', 'approved', 'task'),
    ]);
    const page = await service.list({
      page: 1,
      limit: 1,
      status: 'approved',
      kind: 'task',
      search: 'MEMBER',
      sortOrder: 'asc',
    });
    expect(page.items.map((c) => c['id'])).toEqual(['legacycore.member.open_share']);
    expect(page.meta).toEqual({ page: 1, limit: 1, total: 1, totalPages: 1 });
  });
});
