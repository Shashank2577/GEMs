import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { FileUp, FileText, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface FileDropzoneProps {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  /** Max size in bytes (default 25 MB) */
  maxSize?: number;
  disabled?: boolean;
  title?: ReactNode;
  hint?: ReactNode;
  className?: string;
  onReject?: (message: string) => void;
  /** Currently selected files to preview (controlled by parent) */
  files?: File[];
  onRemove?: (index: number) => void;
}

export function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

export function FileDropzone({
  onFiles, accept = '.pdf,image/*', multiple, maxSize = 25 * 1024 * 1024, disabled, title, hint, className, onReject, files, onRemove,
}: FileDropzoneProps) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  const handle = useCallback((list: FileList | null) => {
    if (!list || disabled) return;
    const arr = Array.from(list).slice(0, multiple ? undefined : 1);
    const tooBig = arr.find((f) => f.size > maxSize);
    if (tooBig) {
      const msg = `${tooBig.name} is larger than ${formatBytes(maxSize)}.`;
      setError(msg); onReject?.(msg); return;
    }
    setError(null);
    if (arr.length) onFiles(arr);
  }, [disabled, multiple, maxSize, onFiles, onReject]);

  return (
    <div className={cn('grid gap-2', className)}>
      <label
        htmlFor={id}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); handle(e.dataTransfer.files); }}
        className={cn(
          'group relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors focus-within:ring-2 focus-within:ring-ring',
          over ? 'border-primary bg-primary-soft' : 'border-border bg-subtle hover:border-primary/50 hover:bg-primary-soft/40',
          disabled && 'pointer-events-none opacity-60',
          error && 'border-danger/50',
        )}
      >
        <span className={cn('flex size-11 items-center justify-center rounded-xl border bg-card shadow-sm transition-transform', over && 'scale-110')}>
          <FileUp className="size-5 text-primary" aria-hidden />
        </span>
        <span className="text-sm font-medium">{title ?? <>Drop file here or <span className="text-primary underline-offset-4 group-hover:underline">browse</span></>}</span>
        <span className="text-xs text-muted-foreground">{hint ?? `PDF or image, up to ${formatBytes(maxSize)}`}</span>
        <input
          ref={input}
          id={id}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          className="sr-only"
          onChange={(e) => { handle(e.target.files); if (input.current) input.current.value = ''; }}
        />
      </label>
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
      {files && files.length > 0 && (
        <ul className="grid gap-1.5">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-xs text-muted-foreground">{formatBytes(f.size)}</span>
              {onRemove && (
                <button type="button" onClick={() => onRemove(i)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-ring" aria-label={`Remove ${f.name}`}>
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
