import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

import { IsStringRecord } from '../../../common/validators/record.validators.js';
import { TENANT_ID } from '../../runs/dto/run.dto.js';

export class InvokeCapabilityDto {
  /** The institution to run against. */
  @Matches(TENANT_ID, { message: 'tenant must be a tenant id such as "acme"' })
  tenant!: string;

  /** Values for the capability's declared inputs; every problem is reported at once (422). */
  @IsOptional()
  @IsStringRecord({ maxKeys: 20, maxValueLength: 500 })
  inputs: Record<string, string> = {};

  /** On an unknown screen: fail with evidence, or wait for an operator to take over in the UI. */
  @IsOptional()
  @IsIn(['fail', 'wait'])
  escalation: 'fail' | 'wait' = 'fail';

  /** How long to hold the request open for the result before answering 202 with the run to poll. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1800)
  waitSeconds = 120;
}

class InvocationLinksDto {
  @ApiProperty({ example: '/api/v1/runs/20261002T060059Z-replay-…' }) run!: string;
  @ApiProperty({ example: 'http://localhost:3000/runs/20261002T060059Z-replay-…' }) ui!: string;
}

/** The capability's result contract: identical over REST, MCP and `rote replay --json`. */
export class InvocationDto {
  @ApiProperty({ enum: ['succeeded', 'business_outcome', 'failed', 'running'] }) status!: string;
  @ApiProperty({ example: 'legacycore.member.get_savings_balance@1.0.3' }) capability!: string;
  @ApiProperty() run_id!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) outputs?: Record<
    string,
    unknown
  >;
  @ApiPropertyOptional({ example: { code: 'MEMBER_NOT_FOUND', message: 'No member matches' } })
  outcome?: Record<string, unknown>;
  @ApiPropertyOptional({ example: { code: 'TARGET_NOT_FOUND', message: '…', retryable: false } })
  failure?: Record<string, unknown>;
  @ApiProperty({ type: InvocationLinksDto }) links!: InvocationLinksDto;
}
