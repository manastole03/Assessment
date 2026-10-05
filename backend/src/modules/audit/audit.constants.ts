/** Every audited action. Stable strings: dashboards and alerts key on them. */
export const AuditAction = {
  AUTH_REGISTER: 'auth.register',
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGIN_FAILED: 'auth.login_failed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_REFRESH_REUSED: 'auth.refresh_token_reused',
  AUTH_PASSWORD_CHANGED: 'auth.password_changed',
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DELETED: 'user.deleted',
  API_KEY_CREATED: 'api_key.created',
  API_KEY_REVOKED: 'api_key.revoked',
  CAPABILITY_APPROVED: 'capability.approved',
  CAPABILITY_INVOKED: 'capability.invoked',
  RUN_STARTED: 'run.started',
  INTERVENTION_CLAIMED: 'intervention.claimed',
  INTERVENTION_RESOLVED: 'intervention.resolved',
  EVAL_STARTED: 'eval.started',
  DEMO_FAULTS_SET: 'demo.faults_set',
  MCP_TOOL_CALLED: 'mcp.tool_called',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
