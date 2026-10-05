import { toAppConfig } from '../../../src/config/configuration.js';
import { parseDurationSeconds, parseEnv } from '../../../src/config/validation.js';

const VALID = {
  DATABASE_URL: 'postgresql://user:pass@db:5432/rote',
  JWT_SECRET: 'k'.repeat(16) + 'Zq8!vR2#mN5$wL7@',
};

describe('configuration validation', () => {
  it('accepts a minimal environment and applies production-safe defaults', () => {
    const env = parseEnv(VALID);
    expect(env.PORT).toBe(3000);
    expect(env.JWT_EXPIRES_IN).toBe(900);
    expect(env.AUTH_ALLOW_SIGNUP).toBe(false);
    expect(env.DEMO_ENABLED).toBe(false);
    expect(env.CORS_ORIGIN).toEqual([]);
  });

  it('fails fast and names every invalid variable at once', () => {
    const attempt = () => parseEnv({ JWT_SECRET: 'short', PORT: 'eighty' });
    expect(attempt).toThrow(/DATABASE_URL: is required/);
    expect(attempt).toThrow(/PORT: /);
    expect(attempt).toThrow(/JWT_SECRET: must be at least 32 characters/);
  });

  it('rejects placeholder secrets', () => {
    expect(() =>
      parseEnv({ ...VALID, JWT_SECRET: 'change-me-change-me-change-me-change-me' }),
    ).toThrow(/placeholder/);
  });

  it('requires an engine token in production', () => {
    expect(() => parseEnv({ ...VALID, NODE_ENV: 'production' })).toThrow(
      /ENGINE_TOKEN: is required in production/,
    );
    expect(() =>
      parseEnv({ ...VALID, NODE_ENV: 'production', ENGINE_TOKEN: 'x'.repeat(32) }),
    ).not.toThrow();
  });

  it('parses booleans, durations and origin lists', () => {
    const env = parseEnv({
      ...VALID,
      DEMO_ENABLED: 'true',
      JWT_EXPIRES_IN: '1h',
      CORS_ORIGIN: 'https://a.example, https://b.example',
    });
    expect(env.DEMO_ENABLED).toBe(true);
    expect(env.JWT_EXPIRES_IN).toBe(3600);
    expect(env.CORS_ORIGIN).toEqual(['https://a.example', 'https://b.example']);
    expect(() => parseEnv({ ...VALID, CORS_ORIGIN: 'not a url' })).toThrow(/CORS_ORIGIN/);
    expect(() => parseEnv({ ...VALID, JWT_EXPIRES_IN: 'soon' })).toThrow(/JWT_EXPIRES_IN/);
  });

  it('turns secure cookies on by default in production only', () => {
    expect(
      toAppConfig(parseEnv({ ...VALID, NODE_ENV: 'production', ENGINE_TOKEN: 'x'.repeat(32) })).auth
        .cookieSecure,
    ).toBe(true);
    expect(toAppConfig(parseEnv({ ...VALID, NODE_ENV: 'development' })).auth.cookieSecure).toBe(
      false,
    );
    expect(
      toAppConfig(
        parseEnv({
          ...VALID,
          NODE_ENV: 'production',
          ENGINE_TOKEN: 'x'.repeat(32),
          COOKIE_SECURE: 'false',
        }),
      ).auth.cookieSecure,
    ).toBe(false);
  });

  it('parses durations', () => {
    expect(parseDurationSeconds('900s')).toBe(900);
    expect(parseDurationSeconds('15m')).toBe(900);
    expect(parseDurationSeconds('2d')).toBe(172800);
    expect(() => parseDurationSeconds('15 minutes')).toThrow();
  });
});
