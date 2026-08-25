import { redact, safeErrorMessage } from './redact';

describe('credential redaction', () => {
  it('removes nested credentials from execution history', () => {
    expect(
      redact({
        authorization: 'Bearer hidden-token',
        nested: { password: 'hidden-password', safe: 'visible' },
      }),
    ).toEqual({
      authorization: '[REDACTED]',
      nested: { password: '[REDACTED]', safe: 'visible' },
    });
  });

  it('removes API keys and bearer tokens from provider errors', () => {
    const message = safeErrorMessage(
      new Error('Bearer sensitive-token failed for sk-proj-sensitive-key'),
    );
    expect(message).not.toContain('sensitive-token');
    expect(message).not.toContain('sk-proj-sensitive-key');
  });
});
