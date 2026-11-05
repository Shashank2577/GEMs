import { describe, expect, it } from 'vitest';
import { changedAssistKeys, isAssistDraftDirty, needsBuild } from './assist-draft';

const fields = [{ key: 'make', value: 'Dell' }, { key: 'model', value: '' }];

describe('assist-values draft (FR-092)', () => {
  it('detects changed keys', () => {
    expect(changedAssistKeys({ make: 'Dell', model: '' }, fields)).toEqual([]);
    expect(changedAssistKeys({ make: 'HP', model: '' }, fields)).toEqual(['make']);
    expect(changedAssistKeys({ make: 'Dell', model: 'Latitude' }, fields)).toEqual(['model']);
    expect(changedAssistKeys({}, fields)).toEqual(['make']); // a missing entry is an empty value
  });
  it('is dirty only while editing with real changes', () => {
    expect(isAssistDraftDirty(false, { make: 'HP' }, fields)).toBe(false);
    expect(isAssistDraftDirty(true, { make: 'Dell', model: '' }, fields)).toBe(false);
    expect(isAssistDraftDirty(true, { make: 'HP', model: '' }, fields)).toBe(true);
  });
});

describe('needsBuild (006 US6 scenario 6)', () => {
  it('is true before a merged packet exists even when other documents are listed', () => {
    expect(needsBuild([])).toBe(true);
    expect(needsBuild([{ kind: 'vault' }, { kind: 'annexure' }])).toBe(true);
    expect(needsBuild([{ kind: 'packet' }, { kind: 'vault' }])).toBe(false);
  });
});
