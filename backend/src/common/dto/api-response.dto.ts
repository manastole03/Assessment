import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ErrorCode } from '../constants/error-codes.js';

/** Swagger models for the envelopes (the runtime shapes are in interfaces/api-response.interface.ts). */
export class PaginationMetaDto {
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
  @ApiProperty({ example: 100 }) total!: number;
  @ApiProperty({ example: 5 }) totalPages!: number;
}

export class ErrorBodyDto {
  @ApiProperty({ enum: Object.values(ErrorCode), example: ErrorCode.USER_NOT_FOUND })
  code!: string;

  @ApiPropertyOptional({
    description: 'Extra context, e.g. one entry per invalid field for VALIDATION_ERROR.',
    oneOf: [
      { type: 'object', additionalProperties: true },
      { type: 'array', items: {} },
    ],
  })
  details?: unknown;
}

export class ErrorResponseDto {
  @ApiProperty({ example: false }) success!: false;
  @ApiProperty({ example: 'User not found' }) message!: string;
  @ApiProperty({ type: ErrorBodyDto }) error!: ErrorBodyDto;
  @ApiProperty({ example: '2026-10-04T00:00:00.000Z' }) timestamp!: string;
  @ApiProperty({ example: '/api/v1/users/123' }) path!: string;
  @ApiPropertyOptional({ example: '0f8d3c1e-6b1a-4f43-9d0b-6a3f7b2e9c11' }) requestId?: string;
}
