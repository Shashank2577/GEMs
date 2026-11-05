/**
 * Client-side pre-upload check shared by every vault file-selection path (T040; FR-023, FR-033): the
 * upload dialog's dropzone and **Change** button, page-level drag & drop and the drawer's **Replace file**.
 * The server re-checks everything (size, magic bytes); this only saves the user a pointless upload.
 */
import { VAULT_ALLOWED_MIME, VAULT_MAX_BYTES } from '@tp/core/contracts/vault';
import { formatBytes } from '@/components/ui/dropzone';

const ALLOWED_EXT = /\.(pdf|png|jpe?g)$/i;

/** Returns the message to show for a file the vault will refuse, or null when it may be uploaded. */
export function checkVaultFile(file: Pick<File, 'name' | 'size' | 'type'>): string | null {
  // Same wording as the dropzone: "<name> is larger than 20 MB."
  if (file.size > VAULT_MAX_BYTES) return `${file.name} is larger than ${formatBytes(VAULT_MAX_BYTES)}.`;
  if (file.size === 0) return 'The file is empty';
  // Browsers report an empty or odd type for some scans, so a matching extension is enough here.
  const okType = (VAULT_ALLOWED_MIME as readonly string[]).includes(file.type) || ALLOWED_EXT.test(file.name);
  if (!okType) return 'Only PDF, PNG and JPG files can be stored in the vault.';
  return null;
}
