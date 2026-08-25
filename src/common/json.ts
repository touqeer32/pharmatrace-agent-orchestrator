export type JsonObject = Record<string, unknown>;

export function parseJsonObject(value: string): JsonObject {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = parseEmbeddedObject(trimmed);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object from the language model');
  }

  return parsed as JsonObject;
}

function parseEmbeddedObject(value: string): unknown {
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== '{') {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < value.length; index += 1) {
      const character = value[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;

        if (depth === 0) {
          try {
            return JSON.parse(value.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error('Expected a JSON object from the language model');
}

export function asJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
