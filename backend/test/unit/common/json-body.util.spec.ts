import { rejectPoisonedKeys } from '../../../src/common/utils/json-body.util.js';

const parse = (text: string): unknown => JSON.parse(text, rejectPoisonedKeys);

describe('rejectPoisonedKeys (JSON body reviver)', () => {
  it('parses ordinary bodies unchanged', () => {
    const body = { email: 'a@example.com', inputs: { member_id: '12345' }, list: [1, { x: null }] };
    expect(parse(JSON.stringify(body))).toEqual(body);
  });

  it.each([
    '{"__proto__":{"polluted":true}}',
    '{"inputs":{"constructor":{"prototype":{"polluted":true}}}}',
    '{"deep":[{"ok":1},{"__proto__":{}}]}',
  ])('rejects %s at any depth', (text) => {
    expect(() => parse(text)).toThrow(/forbidden JSON key/);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('allows the words as values and inside longer keys', () => {
    expect(parse('{"note":"constructor","constructor_id":"1","proto":"x"}')).toEqual({
      note: 'constructor',
      constructor_id: '1',
      proto: 'x',
    });
  });
});
