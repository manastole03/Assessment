import { Role } from '../../generated/prisma/enums.js';

export { Role };

/** Roles are ranked: each one can do everything the roles below it can. */
const RANK: Record<Role, number> = {
  [Role.VIEWER]: 0,
  [Role.OPERATOR]: 1,
  [Role.REVIEWER]: 2,
  [Role.ADMIN]: 3,
};

export const ROLES_ASCENDING: readonly Role[] = [
  Role.VIEWER,
  Role.OPERATOR,
  Role.REVIEWER,
  Role.ADMIN,
];

/** True when `actual` is `required` or ranks above it. */
export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

/** The lower of two roles: an API key never exceeds its owner's current role. */
export function minRole(a: Role, b: Role): Role {
  return RANK[a] <= RANK[b] ? a : b;
}
