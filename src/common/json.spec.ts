import { parseJsonObject } from './json';

describe('parseJsonObject', () => {
  it('parses a fenced JSON object', () => {
    expect(parseJsonObject('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('parses JSON returned after model reasoning text', () => {
    expect(parseJsonObject('I will produce the plan now.\n{"steps":[]}')).toEqual({ steps: [] });
  });

  it('does not accept a JSON array', () => {
    expect(() => parseJsonObject('[1,2,3]')).toThrow();
  });
});
