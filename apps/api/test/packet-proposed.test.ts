import { describe, it, expect } from 'vitest';
import { proposedPacketItems, packetItemUid } from '../src/services/packet';

// 006/FR-055 — pure checks of the proposed packet order (no database).
describe('proposedPacketItems', () => {
  const computed = [
    { kind: 'cover', title: 'Cover' },
    { kind: 'vault', refId: 'v1', title: 'PAN' },
  ] as Parameters<typeof proposedPacketItems>[0];
  const valid = { vaultIds: new Set(['v1']), tenderDocIds: new Set<string>() };

  it('falls back to the computed default when every reference of the last build is stale', () => {
    const lastReady = { items: [{ kind: 'vault', refId: 'gone', title: 'Deleted doc' }], defaultUids: ['vault:gone'] } as never;
    expect(proposedPacketItems(computed, lastReady, valid)).toEqual(computed);
  });

  it('keeps the last build order and leaves deliberately removed items out', () => {
    const lastReady = { items: [{ kind: 'vault', refId: 'v1', title: 'PAN' }], defaultUids: computed.map(packetItemUid) } as never;
    const out = proposedPacketItems(computed, lastReady, valid);
    expect(out.map((i) => i.kind)).toEqual(['vault']);
  });
});
