import commandSchema from '../schema/command.schema.json' with { type: 'json' };

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; enum?: unknown[]; const?: unknown; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; items?: Schema; oneOf?: Schema[]; allOf?: Schema[]; if?: Schema; then?: Schema };
export const COMMAND_SCHEMA = commandSchema;

/** The wire schema deliberately uses a small auditable JSON Schema vocabulary. */
function validate(schema: Schema, value: unknown, path: string): string | undefined {
  if (schema.const !== undefined && value !== schema.const) return `${path} must be ${String(schema.const)}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} is not a supported value`;
  if (schema.oneOf && schema.oneOf.filter(option => validate(option, value, path) === undefined).length !== 1) return `${path} must match one supported shape`;
  if (schema.if && validate(schema.if, value, path) === undefined && schema.then) { const error = validate(schema.then, value, path); if (error) return error; }
  if (schema.allOf) for (const part of schema.allOf) { const error = validate(part, value, path); if (error) return error; }
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return `${path} must be an object`;
  if (schema.type === 'array' && !Array.isArray(value)) return `${path} must be an array`;
  if (schema.type === 'string' && typeof value !== 'string') return `${path} must be a string`;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${path} must be boolean`;
  if (schema.type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value))) return `${path} must be a safe integer`;
  if (typeof value === 'string' && (schema.minLength !== undefined && [...value].length < schema.minLength || schema.maxLength !== undefined && [...value].length > schema.maxLength)) return `${path} has an invalid length`;
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) return `${path} is out of range`;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has an invalid item count`;
    if (schema.items) for (let index = 0; index < value.length; index++) { const error = validate(schema.items, value[index], `${path}[${index}]`); if (error) return error; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) return `${path}.${key} is required`;
    for (const [key, entry] of Object.entries(object)) {
      const property = schema.properties?.[key]; if (!property && schema.additionalProperties === false) return `${path}.${key} is not allowed`;
      if (property) { const error = validate(property, entry, `${path}.${key}`); if (error) return error; }
    }
  }
  return undefined;
}
export function commandValidationError(value: unknown): string | undefined { return validate(commandSchema as unknown as Schema, value, 'command'); }
