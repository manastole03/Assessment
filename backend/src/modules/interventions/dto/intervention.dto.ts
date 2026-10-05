import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import {
  PaginationQueryDto,
  SORT_ORDERS,
  type SortOrder,
} from '../../../common/dto/pagination-query.dto.js';

export const INTERVENTION_STATUSES = ['open', 'claimed', 'resolved', 'expired'] as const;
export type InterventionStatusName = (typeof INTERVENTION_STATUSES)[number];

export class ListInterventionsQueryDto extends PaginationQueryDto {
  /** `open` is the queue of runs waiting for a person. */
  @IsOptional() @IsIn(INTERVENTION_STATUSES) status?: InterventionStatusName;
  @IsOptional() @Matches(/^[A-Z_]{1,64}$/) reasonCode?: string;
  @IsOptional() @IsString() @MaxLength(200) runId?: string;
  @IsOptional() @IsIn(SORT_ORDERS) sortOrder: SortOrder = 'desc';
}
