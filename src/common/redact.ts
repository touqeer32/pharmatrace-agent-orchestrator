const SENSITIVE_KEY =
  /(api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|client[_-]?secret)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item),
      ]),
    );
  }

  return value;
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .slice(0, 1500);
}
