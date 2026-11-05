import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** "Priya Sharma" → "PS"; with `firstTwo` (orgs): "Sharma Infotech Pvt Ltd" → "SI" */
export function initials(name?: string | null, firstTwo = false) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[firstTwo ? 1 : parts.length - 1][0] : '')).toUpperCase() || '?';
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
