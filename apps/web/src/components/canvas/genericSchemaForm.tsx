/**
 * Schema-driven generic node form. Introspects a zod object schema (one of
 * `genericFormNodeConfigSchemas` from `@agentis/core`) and renders real typed
 * inputs — text/number/checkbox/select — bound through the same `update()`
 * patch callback every other `XxxForm` in ContextInspector.tsx uses. Any field
 * whose type isn't a simple scalar (arrays, records, nested objects, unions)
 * falls back to a raw JSON editor for just that one field.
 *
 * This replaces the old behavior of GenericForm, which only ever looked at
 * the node's *current* data keys (so a brand-new node with no config yet
 * rendered nothing). Reading the schema instead means every field the kind
 * supports shows up immediately, populated or not.
 */
import { useMemo } from 'react';
import type { z } from 'zod';

type FieldKind = 'string' | 'number' | 'boolean' | 'select' | 'json';

interface FieldSpec {
  key: string;
  kind: FieldKind;
  options?: string[];
  hasDefault: boolean;
}

/** Unwrap ZodOptional/ZodNullable/ZodDefault wrappers to the underlying type. */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; hasDefault: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inner: any = schema;
  let hasDefault = false;
  for (;;) {
    const typeName = inner?._def?.typeName;
    if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
      inner = inner._def.innerType;
      continue;
    }
    if (typeName === 'ZodDefault') {
      hasDefault = true;
      inner = inner._def.innerType;
      continue;
    }
    break;
  }
  return { inner, hasDefault };
}

/** Derive a simple input kind (+ enum options) from a zod field, defaulting to raw JSON. */
function describeField(rawSchema: z.ZodTypeAny): { kind: FieldKind; options?: string[] } {
  const { inner } = unwrap(rawSchema);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const typeName = (inner as any)?._def?.typeName;
  switch (typeName) {
    case 'ZodString':
      return { kind: 'string' };
    case 'ZodNumber':
      return { kind: 'number' };
    case 'ZodBoolean':
      return { kind: 'boolean' };
    case 'ZodEnum':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { kind: 'select', options: [...((inner as any)._def.values as string[])] };
    default:
      return { kind: 'json' };
  }
}

/** Build the field list for a node-config zod object schema, skipping display-only fields. */
export function fieldSpecsForSchema(schema: z.AnyZodObject): FieldSpec[] {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  return Object.keys(shape)
    .filter((key) => key !== 'kind' && key !== 'isOutput')
    .map((key) => {
      const raw = shape[key] as z.ZodTypeAny;
      const { hasDefault } = unwrap(raw);
      const { kind, options } = describeField(raw);
      return { key, kind, options, hasDefault };
    });
}

function humanizeKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

const inputCls =
  'h-8 w-full rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';
const textareaCls =
  'w-full resize-none rounded-input border border-line bg-surface-2 px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';
const selectCls = inputCls;

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-[11px] font-medium text-text-secondary">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[10px] text-text-muted">{hint}</p>}
    </div>
  );
}

/**
 * Render every field of `schema` as a typed input bound to `data`/`update`.
 * Used as the default form body for node kinds with no dedicated `XxxForm`.
 */
export function SchemaDrivenFields({
  schema,
  data,
  update,
}: {
  schema: z.AnyZodObject;
  data: Record<string, unknown>;
  update: (patch: Record<string, unknown>) => void;
}) {
  const fields = useMemo(() => fieldSpecsForSchema(schema), [schema]);
  return (
    <>
      {fields.map((field) => {
        const value = data[field.key];
        const label = humanizeKey(field.key) + (field.hasDefault ? '' : ' *');
        if (field.kind === 'boolean') {
          return (
            <FieldRow key={field.key} label={label}>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(e) => update({ [field.key]: e.target.checked })}
                  className="rounded border-line bg-surface-2 accent-accent"
                />
                <span className="text-[12px] text-text-primary">{value ? 'true' : 'false'}</span>
              </label>
            </FieldRow>
          );
        }
        if (field.kind === 'number') {
          return (
            <FieldRow key={field.key} label={label}>
              <input
                type="number"
                className={inputCls}
                value={typeof value === 'number' ? value : ''}
                onChange={(e) => update({ [field.key]: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            </FieldRow>
          );
        }
        if (field.kind === 'select') {
          return (
            <FieldRow key={field.key} label={label}>
              <select
                className={selectCls}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => update({ [field.key]: e.target.value || undefined })}
              >
                <option value="">— Select —</option>
                {(field.options ?? []).map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </FieldRow>
          );
        }
        if (field.kind === 'string') {
          return (
            <FieldRow key={field.key} label={label}>
              <input
                type="text"
                className={inputCls}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => update({ [field.key]: e.target.value })}
              />
            </FieldRow>
          );
        }
        // Complex shape (array/object/record/union) — raw JSON editor for just this field.
        return (
          <FieldRow key={field.key} label={label} hint="Complex value — edit as JSON.">
            <textarea
              rows={3}
              spellCheck={false}
              className={textareaCls + ' font-mono text-[11px]'}
              defaultValue={value === undefined ? '' : JSON.stringify(value, null, 2)}
              onBlur={(e) => {
                const text = e.target.value.trim();
                if (!text) { update({ [field.key]: undefined }); return; }
                try { update({ [field.key]: JSON.parse(text) as unknown }); }
                catch { /* leave parent value unchanged on invalid JSON */ }
              }}
            />
          </FieldRow>
        );
      })}
    </>
  );
}
