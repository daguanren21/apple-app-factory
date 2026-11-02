import { compile, str, type Schema, type Validator } from '@earendil-works/pi-schema';

export interface ContractIssue { path: (string | number)[]; message: string }
export class ContractError extends Error {
  constructor(readonly issues: ContractIssue[]) {
    super(issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '));
    this.name = 'ContractError';
  }
}
export interface Contract<T> {
  readonly schema: Schema<T>;
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: ContractError };
}
export type Parsed<C> = C extends Contract<infer T> ? T : never;
type Issue = (path: (string | number)[], message: string) => void;
interface Policy<T> { check?: (value: T, issue: Issue) => void; normalize?: (value: T) => T; stripUnknown?: boolean }
// Embed child .schema objects directly; cloning one discards its parsing policy.
const policies = new WeakMap<object, Policy<unknown>>();
const validators = new WeakMap<object, Validator>();
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const childSchema = (value: unknown): value is Schema => object(value);

function utcDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}
function email(value: string): boolean {
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  const labels = domain.split('.');
  return local.split('.').every(part => /^[A-Za-z0-9_'+-]+$/.test(part))
    && /[A-Za-z0-9_+-]$/.test(local) && labels.length >= 2
    && /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]!)
    && labels.slice(0, -1).every(label => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(label));
}
const formats = {
  'date-time': utcDateTime,
  uuid: (value: string): boolean => value === '00000000-0000-0000-0000-000000000000'
    || value === 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  email,
  url: (value: string): boolean => { try { new URL(value.trim()); return true; } catch { return false; } },
};
function validator(schema: Schema): Validator {
  let value = validators.get(schema);
  if (!value) { value = compile(schema, { formats }); validators.set(schema, value); }
  return value;
}

// Defaults/known-container copies are application parsing policy, not pi-schema
// coercion. Unknown payloads remain opaque and strict native schemas reject extras.
function prepare(schema: Schema, input: unknown): unknown {
  if (input === undefined && own(schema, 'default')) return prepare(schema, structuredClone(schema.default));
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) if (childSchema(branch)) {
      const candidate = prepare(branch, input);
      if (validator(branch).check(candidate)) return candidate;
    }
    return input;
  }
  if (schema.type === 'array' && Array.isArray(input) && childSchema(schema.items)) {
    return input.map(value => prepare(schema.items as Schema, value));
  }
  if (schema.type === 'object' && object(input)) {
    const properties = object(schema.properties) ? schema.properties : {};
    // Known fields retain schema order: persisted request digests use their JSON.
    const result: Record<string, unknown> = {};
    const assign = (key: string, value: unknown): void => {
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
    };
    for (const [key, property] of Object.entries(properties)) if (childSchema(property)) {
      const value = prepare(property, own(input, key) ? input[key] : undefined);
      if (value !== undefined || own(input, key)) assign(key, value);
    }
    if (!policies.get(schema)?.stripUnknown) {
      for (const key of Object.keys(input)) if (!own(properties, key)) {
        if (childSchema(schema.additionalProperties)) {
          if (key === '__proto__') continue;
          assign(key, prepare(schema.additionalProperties, input[key]));
        } else assign(key, input[key]);
      }
    }
    return result;
  }
  return input;
}
function semantics(schema: Schema, input: unknown, path: (string | number)[], issues: ContractIssue[]): unknown {
  let value = input;
  if (Array.isArray(schema.anyOf)) {
    const branch = schema.anyOf.find(candidate => childSchema(candidate) && validator(candidate).check(value));
    if (childSchema(branch)) value = semantics(branch, value, path, issues);
  } else if (schema.type === 'array' && Array.isArray(value) && childSchema(schema.items)) {
    for (let index = 0; index < value.length; index++) value[index] = semantics(schema.items, value[index], [...path, index], issues);
  } else if (schema.type === 'object' && object(value)) {
    const properties = object(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(value)) {
      // Preserve legacy container parsing: validate unknown keys first, then
      // omit the special prototype key rather than exposing it downstream.
      if (key === '__proto__') { delete value[key]; continue; }
      const property = own(properties, key) ? properties[key] : schema.additionalProperties;
      if (childSchema(property) && value[key] !== undefined) value[key] = semantics(property, value[key], [...path, key], issues);
    }
  }
  const policy = policies.get(schema);
  if (policy?.normalize) value = policy.normalize(value);
  policy?.check?.(value, (relative, message) => issues.push({ path: [...path, ...relative], message }));
  return value;
}
export function defineContract<T>(schema: Schema<T>, policy: Policy<T> = {}): Contract<T> {
  policies.set(schema, policy as Policy<unknown>);
  const checked = validator(schema);
  const parse = (input: unknown): T => {
    const prepared = prepare(schema, input);
    if (!checked.check(prepared)) {
      throw new ContractError(checked.errors(prepared).map(error => ({
        path: error.path.split('/').slice(1).map(part => /^\d+$/.test(part) ? Number(part) : part.replaceAll('~1', '/').replaceAll('~0', '~')),
        message: error.message,
      })));
    }
    const issues: ContractIssue[] = [];
    const output = semantics(schema, prepared, [], issues);
    if (issues.length) throw new ContractError(issues);
    return output as T;
  };
  return { schema, parse, safeParse(input) {
    try { return { success: true, data: parse(input) }; }
    catch (error) { if (error instanceof ContractError) return { success: false, error }; throw error; }
  } };
}
export function enumValues<T extends string>(contract: Contract<T>): readonly T[] {
  const values = contract.schema.enum;
  if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) throw new Error('Contract is not a string enum');
  return values as T[];
}
export function nonblankText(max?: number): Schema<string> {
  return str({ minLength: 1, ...(max === undefined ? {} : { maxLength: max }), pattern: '^(?![\\s\\S]*\\u0000)(?=[\\s\\S]*\\S)[\\s\\S]*$' });
}
export function uuidSchema(): Schema<string> { return str({ format: 'uuid' }); }
export function isoDateTimeSchema(max?: number): Schema<string> { return str({ format: 'date-time', ...(max === undefined ? {} : { maxLength: max }) }); }
export function urlSchema(options: { nonblank?: boolean; description?: string } = {}): Schema<string> {
  return defineContract({ ...(options.nonblank ? nonblankText() : str()), format: 'url', ...(options.description ? { description: options.description } : {}) }, {
    normalize: value => value.trim().replace(/[\t\n\r]/g, ''),
  }).schema;
}
export function emailSchema(): Schema<string> { return str({ format: 'email' }); }
