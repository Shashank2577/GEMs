import { describe, expect, it } from 'vitest';
import { VAULT_MAX_BYTES } from '@tp/core/contracts/vault';
import { checkVaultFile } from './file-check';

const f = (name: string, size: number, type = 'application/pdf') => ({ name, size, type });

describe('checkVaultFile (T040; FR-023, FR-033)', () => {
  it('accepts PDF, PNG and JPG up to 20 MB', () => {
    expect(checkVaultFile(f('gst.pdf', 1000))).toBeNull();
    expect(checkVaultFile(f('scan.png', 1000, 'image/png'))).toBeNull();
    expect(checkVaultFile(f('scan.JPEG', 1000, ''))).toBeNull();
    expect(checkVaultFile(f('exactly.pdf', VAULT_MAX_BYTES))).toBeNull();
  });
  it('uses the dropzone message for files over 20 MB', () => {
    expect(checkVaultFile(f('big scan.pdf', 25 * 1024 * 1024))).toBe('big scan.pdf is larger than 20 MB.');
    expect(checkVaultFile(f('a.pdf', VAULT_MAX_BYTES + 1))).toBe('a.pdf is larger than 20 MB.');
  });
  it('refuses empty files and other types', () => {
    expect(checkVaultFile(f('empty.pdf', 0))).toBe('The file is empty');
    expect(checkVaultFile(f('notes.docx', 10, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).toBe('Only PDF, PNG and JPG files can be stored in the vault.');
  });
});
