import { describe, expect, it } from 'vitest';
import { matchesRecordPredicate, recordActionLabel, visibleRecordActions } from '../src/components/apps/recordActions';

describe('record action availability', () => {
  const row = { status: 'queued', approved: true, score: 9, tags: ['priority'], owner: { id: 'agent-1' } };

  it('supports nested fields and the bounded operator vocabulary', () => {
    expect(matchesRecordPredicate({ all: [
      { field: 'status', op: 'in', value: ['queued', 'active'] },
      { field: 'approved', op: 'truthy' },
      { field: 'score', op: 'gte', value: 8 },
      { field: 'owner.id', op: 'eq', value: 'agent-1' },
    ] }, row, {})).toBe(true);
  });

  it('combines all/any groups and resolves state/row bindings', () => {
    expect(matchesRecordPredicate({
      all: [{ field: 'status', op: 'eq', value: { $state: 'expected' } }],
      any: [{ field: 'score', op: 'eq', value: { $row: 'score' } }, { field: 'approved', op: 'falsy' }],
    }, row, { expected: 'queued' })).toBe(true);
  });

  it('filters invisible actions and honors human labels', () => {
    const visible = visibleRecordActions([
      { action: 'start_work', label: 'Start now', visibleWhen: { all: [{ field: 'status', op: 'eq', value: 'queued' }] } },
      { action: 'complete_work', visibleWhen: { all: [{ field: 'status', op: 'eq', value: 'active' }] } },
    ], row, {});
    expect(visible.map(recordActionLabel)).toEqual(['Start now']);
  });
});

