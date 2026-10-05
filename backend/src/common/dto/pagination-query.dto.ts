import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/** `?page=1&limit=20`, shared by every collection endpoint. */
export class PaginationQueryDto {
  /** 1-based page number. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page: number = 1;

  /** Items per page (at most 100). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

/** Pagination plus free-text search and a sort direction. Each list DTO whitelists its own `sortBy`. */
export class ListQueryDto extends PaginationQueryDto {
  /** Case-insensitive substring match on the resource's main text fields. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(SORT_ORDERS)
  sortOrder: SortOrder = 'desc';
}
