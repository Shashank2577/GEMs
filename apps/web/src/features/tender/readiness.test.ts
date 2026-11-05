import { describe, expect, it } from 'vitest';
import { readinessChip } from './readiness';

describe('readinessChip (FR-040)', () => {
  it('maps statuses to text labels', () => {
    expect(readinessChip({ status: 'ready' })).toMatchObject({ label: 'In vault', icon: 'ok' });
    expect(readinessChip({ status: 'expiring', days: 10 })).toMatchObject({ label: 'Expires in 10 days', tone: 'warning' });
    expect(readinessChip({ status: 'expiring', days: 1 })!.label).toBe('Expires in 1 day');
    expect(readinessChip({ status: 'expiring', days: 0 })!.label).toBe('Expires today');
    expect(readinessChip({ status: 'expired' })).toMatchObject({ label: 'Expired', tone: 'danger' });
    expect(readinessChip({ status: 'missing' })).toMatchObject({ label: 'Missing', tone: 'danger' });
  });
  it('shows nothing for n/a or unknown', () => {
    expect(readinessChip({ status: 'n/a' })).toBeNull();
    expect(readinessChip(undefined)).toBeNull();
  });
});
