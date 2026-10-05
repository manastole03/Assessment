import { applyDecorators, HttpStatus, type Type } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiResponse,
  ApiSecurity,
  ApiUnauthorizedResponse,
  getSchemaPath,
  type ReferenceObject,
  type SchemaObject,
} from '@nestjs/swagger';

import { ErrorResponseDto, PaginationMetaDto } from '../dto/api-response.dto.js';

type DataModel = Type<unknown> | SchemaObject;

/** A passthrough engine document (artifact, result, event): its schema lives in schemas/*.schema.json. */
export const JSON_DOCUMENT: SchemaObject = { type: 'object', additionalProperties: true };

function dataSchema(model: DataModel | null, isArray: boolean): SchemaObject | ReferenceObject {
  if (model === null) return { type: 'object', nullable: true, example: null };
  const item: SchemaObject | ReferenceObject =
    typeof model === 'function' ? { $ref: getSchemaPath(model) } : model;
  return isArray ? { type: 'array', items: item } : item;
}

interface EnvelopeOptions {
  status?: HttpStatus;
  description?: string;
  isArray?: boolean;
}

/** Documents `{ success: true, data: <model>, message }`. */
export function ApiEnvelope(model: DataModel | null, options: EnvelopeOptions = {}) {
  const decorators = [
    ApiResponse({
      status: options.status ?? HttpStatus.OK,
      description: options.description ?? 'Request successful',
      schema: {
        type: 'object',
        required: ['success', 'data'],
        properties: {
          success: { type: 'boolean', example: true },
          data: dataSchema(model, options.isArray ?? false),
          message: { type: 'string', example: 'Request successful' },
        },
      },
    }),
  ];
  if (typeof model === 'function') decorators.unshift(ApiExtraModels(model));
  return applyDecorators(...decorators);
}

/** Documents `{ success: true, data: <model>[], meta: { page, limit, total, totalPages } }`. */
export function ApiPaginatedEnvelope(model: DataModel, description = 'A page of results') {
  const decorators = [
    ApiExtraModels(PaginationMetaDto),
    ApiResponse({
      status: HttpStatus.OK,
      description,
      schema: {
        type: 'object',
        required: ['success', 'data', 'meta'],
        properties: {
          success: { type: 'boolean', example: true },
          data: dataSchema(model, true),
          meta: { $ref: getSchemaPath(PaginationMetaDto) },
        },
      },
    }),
  ];
  if (typeof model === 'function') decorators.unshift(ApiExtraModels(model));
  return applyDecorators(...decorators);
}

const ERROR_DESCRIPTIONS: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Invalid request (VALIDATION_ERROR lists every field)',
  [HttpStatus.UNAUTHORIZED]: 'Not signed in, or the token/key is invalid or expired',
  [HttpStatus.FORBIDDEN]: 'Signed in, but the role or a business rule does not allow this',
  [HttpStatus.NOT_FOUND]: 'The resource does not exist',
  [HttpStatus.CONFLICT]: 'The request conflicts with the current state',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'The inputs violate the capability contract',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Rate limit exceeded',
  [HttpStatus.BAD_GATEWAY]: 'The engine failed while handling the request',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'The engine or database is unavailable',
  [HttpStatus.GATEWAY_TIMEOUT]: 'The engine did not answer in time',
};

/** Documents error envelopes for the given statuses. */
export function ApiErrors(...statuses: HttpStatus[]) {
  return applyDecorators(
    ApiExtraModels(ErrorResponseDto),
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: ERROR_DESCRIPTIONS[status] ?? 'Error',
        type: ErrorResponseDto,
      }),
    ),
  );
}

/** Every authenticated route: session cookie, bearer token or API key; 401 and 403 documented. */
export function ApiAuth() {
  return applyDecorators(
    ApiCookieAuth('session'),
    ApiBearerAuth('bearer'),
    ApiSecurity('apiKey'),
    ApiUnauthorizedResponse({
      description: ERROR_DESCRIPTIONS[HttpStatus.UNAUTHORIZED],
      type: ErrorResponseDto,
    }),
    ApiForbiddenResponse({
      description: ERROR_DESCRIPTIONS[HttpStatus.FORBIDDEN],
      type: ErrorResponseDto,
    }),
  );
}
