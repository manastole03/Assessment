import { ValidationPipe, type ValidationError } from '@nestjs/common';

import { AppException } from '../exceptions/app.exception.js';

export interface FieldError {
  field: string;
  messages: string[];
}

/** Flatten nested validation errors to `{ field: "steps.0.name", messages: [...] }`. */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = error.constraints ? [{ field, messages: Object.values(error.constraints) }] : [];
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

/**
 * The global pipe: strip unknown properties and reject them (whitelist + forbidNonWhitelisted),
 * coerce query/path strings into the DTO's types (transform), and report every problem at once.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    stopAtFirstError: false,
    exceptionFactory: (errors) => {
      const fields = flattenValidationErrors(errors);
      const summary = fields
        .map((f) => f.messages[0])
        .filter(Boolean)
        .slice(0, 3)
        .join('; ');
      return AppException.validation(
        summary ? `Validation failed: ${summary}` : 'Validation failed',
        fields,
      );
    },
  });
}
