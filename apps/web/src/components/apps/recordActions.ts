import type { RecordActionRef, RecordCondition, RecordPredicate } from '@agentis/core';

export type RecordRow = Record<string, unknown>;

function valueAt(source: RecordRow, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((value, key) => (
    value != null && typeof value === 'object' ? (value as RecordRow)[key] : undefined
  ), source);
}

function conditionValue(value: unknown, row: RecordRow, state: RecordRow): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const bind = value as { $row?: string; $bind?: string; $state?: string };
  if (bind.$row) return valueAt(row, bind.$row);
  if (bind.$bind) return valueAt(row, bind.$bind);
  if (bind.$state) return valueAt(state, bind.$state);
  return value;
}

function matchesCondition(condition: RecordCondition, row: RecordRow, state: RecordRow): boolean {
  const actual = valueAt(row, condition.field);
  const expected = conditionValue(condition.value, row, state);
  const list = Array.isArray(expected) ? expected : [expected];
  switch (condition.op) {
    case 'neq': return actual !== expected;
    case 'in': return list.includes(actual);
    case 'not_in': return !list.includes(actual);
    case 'exists': return actual !== undefined && actual !== null;
    case 'not_exists': return actual === undefined || actual === null;
    case 'truthy': return Boolean(actual);
    case 'falsy': return !actual;
    case 'contains': return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '').includes(String(expected ?? ''));
    case 'gt': return Number(actual) > Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'eq':
    default: return actual === expected;
  }
}

export function matchesRecordPredicate(predicate: RecordPredicate | undefined, row: RecordRow, state: RecordRow): boolean {
  if (!predicate) return true;
  const all = predicate.all?.every((condition) => matchesCondition(condition, row, state)) ?? true;
  const any = predicate.any?.some((condition) => matchesCondition(condition, row, state)) ?? true;
  return all && any;
}

export function visibleRecordActions(actions: RecordActionRef[] | undefined, row: RecordRow, state: RecordRow): RecordActionRef[] {
  return (actions ?? []).filter((action) => matchesRecordPredicate(action.visibleWhen, row, state));
}

export function recordActionLabel(action: RecordActionRef): string {
  const spaced = action.action.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return action.label ?? (spaced.charAt(0).toUpperCase() + spaced.slice(1));
}

