import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

import { isJsonObject } from '../interfaces/json.interface.js';

interface StringRecordOptions {
  maxKeys: number;
  maxValueLength: number;
  keyPattern?: RegExp;
}

/** A flat `{ key: string }` object with bounded size: capability inputs. */
export function IsStringRecord(
  options: StringRecordOptions,
  validationOptions?: ValidationOptions,
) {
  const keyPattern = options.keyPattern ?? /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: 'isStringRecord',
      target: target.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (!isJsonObject(value)) return false;
          const entries = Object.entries(value);
          return (
            entries.length <= options.maxKeys &&
            entries.every(
              ([key, item]) =>
                keyPattern.test(key) &&
                typeof item === 'string' &&
                item.length <= options.maxValueLength,
            )
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be an object of at most ${options.maxKeys} string values (keys like "member_id", values up to ${options.maxValueLength} characters)`;
        },
      },
    });
  };
}

/** A flat object of scalars (booleans, numbers, short strings): demo fault switches. */
export function IsScalarRecord(maxKeys: number, validationOptions?: ValidationOptions) {
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: 'isScalarRecord',
      target: target.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (!isJsonObject(value)) return false;
          const entries = Object.entries(value);
          return (
            entries.length <= maxKeys &&
            entries.every(
              ([key, item]) =>
                /^[a-z_][a-z0-9_]{0,63}$/.test(key) &&
                (typeof item === 'boolean' ||
                  (typeof item === 'number' && Number.isFinite(item)) ||
                  (typeof item === 'string' && item.length <= 200)),
            )
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be an object of at most ${maxKeys} boolean, number or short string values`;
        },
      },
    });
  };
}
