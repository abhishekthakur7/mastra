const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_STRING_LENGTH = 2_048;
const DEFAULT_MAX_ARRAY_ITEMS = 100;
const DEFAULT_MAX_OBJECT_KEYS = 100;
const MAX_SECRET_VALUES = 100;
const MAX_SECRET_VALUE_ENTRIES = 100;
const MAX_SECRET_VALUE_LENGTH = 4_096;
const MAX_OBJECT_KEY_LENGTH = 256;
const TRUNCATED_KEY_SUFFIX = '...[truncated]';

const SENSITIVE_KEY = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|cookie|token)/i;
const URL_PATTERN = /\b(?:https?|ftp|file):\/\/[^\s"'<>]+/gi;
const BEARER_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const TOKEN_PATTERN = /\b(?:sk|pk|ghp|github_pat|xox[baprs]-|AIza)[A-Za-z0-9_-]{8,}\b/g;
const INLINE_SECRET_PATTERN = /\b(?:token|secret|password|credential|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi;

export type FixtureRedactorOptions = {
  secretValues?: Iterable<string>;
  maxDepth?: number;
  maxStringLength?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
};

/**
 * Values accepted from the parsed protocol boundary. Callers must not pass
 * objects with executable accessors, Proxy traps, or other host-language
 * behavior to the redactor.
 */
export type FixtureRedactorInput =
  | null
  | boolean
  | number
  | string
  | FixtureRedactorInput[]
  | { [key: string]: FixtureRedactorInput };

export class FixtureRedactor {
  private readonly secretValues: string[];
  private readonly maxDepth: number;
  private readonly maxStringLength: number;
  private readonly maxArrayItems: number;
  private readonly maxObjectKeys: number;

  constructor(options: FixtureRedactorOptions = {}) {
    this.secretValues = materializeSecretValues(options.secretValues);
    this.maxDepth = boundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 0, 32);
    this.maxStringLength = boundedInteger(options.maxStringLength, DEFAULT_MAX_STRING_LENGTH, 16, 16_384);
    this.maxArrayItems = boundedInteger(options.maxArrayItems, DEFAULT_MAX_ARRAY_ITEMS, 0, 1_000);
    this.maxObjectKeys = boundedInteger(options.maxObjectKeys, DEFAULT_MAX_OBJECT_KEYS, 0, 1_000);
  }

  /**
   * Redact parsed JSON-compatible protocol data. The unknown signature keeps
   * this boundary defensive for runtime callers; inputs outside
   * FixtureRedactorInput are outside the fixture contract.
   */
  redact(value: unknown): unknown {
    return this.visit(value, 0, new WeakSet<object>());
  }

  private visit(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.redactString(value);
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') return '[Unsupported]';
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    if (depth >= this.maxDepth) return '[MaxDepth]';

    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const items = value
          .slice(0, this.maxArrayItems)
          .map(item => this.visit(item, depth + 1, seen));
        if (value.length > this.maxArrayItems) items.push(`[${value.length - this.maxArrayItems} items omitted]`);
        return items;
      }

      const output: Record<string, unknown> = {};
      let enumeratedKeys = 0;
      let omittedKeys = false;
      let redactedKeys = 0;
      const objectValue = value as Record<string, unknown>;

      // Parsed JSON objects have ordinary, bounded own keys. Sensitive names
      // never become output keys and their values are not read at all.
      for (const key in objectValue) {
        if (enumeratedKeys >= this.maxObjectKeys) {
          omittedKeys = true;
          break;
        }
        enumeratedKeys += 1;

        if (!Object.prototype.hasOwnProperty.call(objectValue, key)) continue;

        if (SENSITIVE_KEY.test(key)) {
          defineOutput(output, `[REDACTED_KEY_${++redactedKeys}]`, '[REDACTED]');
          continue;
        }

        defineOutput(output, boundedObjectKey(key), this.visit(objectValue[key], depth + 1, seen));
      }
      if (omittedKeys) defineOutput(output, '__omittedKeys', '[additional keys omitted]');
      return output;
    } finally {
      seen.delete(value);
    }
  }

  private redactString(value: string): string {
    let redacted = value;
    for (const secret of this.secretValues) redacted = redacted.split(secret).join('[REDACTED]');
    redacted = redacted
      .replace(URL_PATTERN, '[REDACTED_URL]')
      .replace(BEARER_PATTERN, '[REDACTED]')
      .replace(TOKEN_PATTERN, '[REDACTED]')
      .replace(INLINE_SECRET_PATTERN, '[REDACTED]');
    if (redacted.length <= this.maxStringLength) return redacted;
    const suffix = '...[truncated]';
    return `${redacted.slice(0, Math.max(0, this.maxStringLength - suffix.length))}${suffix}`;
  }
}

function materializeSecretValues(values: Iterable<string> | undefined): string[] {
  if (!values) return [];

  const secretValues: string[] = [];
  let examinedEntries = 0;
  for (const value of values) {
    examinedEntries += 1;
    if (typeof value === 'string' && value.length > 0) {
      secretValues.push(value.slice(0, MAX_SECRET_VALUE_LENGTH));
    }
    if (secretValues.length >= MAX_SECRET_VALUES || examinedEntries >= MAX_SECRET_VALUE_ENTRIES) break;
  }
  return secretValues.sort((left, right) => right.length - left.length);
}

function boundedObjectKey(key: string): string {
  if (key.length <= MAX_OBJECT_KEY_LENGTH) return key;
  return `${key.slice(0, Math.max(0, MAX_OBJECT_KEY_LENGTH - TRUNCATED_KEY_SUFFIX.length))}${TRUNCATED_KEY_SUFFIX}`;
}

function defineOutput(output: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(output, key, { configurable: true, enumerable: true, value, writable: true });
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) throw new Error(`redactor limit must be an integer between ${minimum} and ${maximum}`);
  return Math.min(Math.max(value, minimum), maximum);
}
