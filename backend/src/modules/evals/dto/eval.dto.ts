import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class StartEvalDto {
  /** A dataset id from GET /evals/datasets, e.g. `replay`. */
  @Matches(SLUG, { message: 'dataset must be a dataset id' })
  dataset!: string;

  /** offline: stand-ins for the model; live: the real model (costs money). */
  @IsOptional()
  @IsIn(['offline', 'live'])
  mode: 'offline' | 'live' = 'offline';

  /** Trials per case (pass^k measures determinism). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  trials = 1;

  /** Run only these case ids. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @Matches(SLUG, { each: true })
  cases?: string[];
}

export class ListEvalResultsQueryDto extends PaginationQueryDto {
  @IsOptional() @Matches(SLUG) dataset?: string;
  @IsOptional() @IsIn(['running', 'completed', 'error']) status?: 'running' | 'completed' | 'error';
}

export class EvalStartedDto {
  @ApiProperty({ example: '20261002T060143Z-replay-offline' }) id!: string;
}
