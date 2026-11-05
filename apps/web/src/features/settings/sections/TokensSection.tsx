import { useState, type FormEvent } from 'react';
import { AlertTriangle, Check, Chrome, Copy, KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { API_TOKEN_LIMIT, type ApiTokenSummary, type CreatedApiToken } from '@tp/core/contracts/auth';
import {
  Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, Field,
  Input, Kbd, Select, SkeletonList, toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { formatDateIST, relativeTime } from '@/lib/format';
import { copyText, useCreateToken, useRevokeToken, useTokens } from '../api';
import { DEFAULT_TOKEN_EXPIRY_CHOICE, TOKEN_EXPIRY_OPTIONS, expiresInDaysFor, tokenExpiry, tokenHintLabel, type TokenExpiryChoice } from '../token-expiry';
import { Panel } from './Panel';

export default function TokensSection() {
  const q = useTokens();
  const revoke = useRevokeToken();
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState<ApiTokenSummary | null>(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-tenderpilot-url';

  return (
    <div className="grid gap-6">
      <Panel title="API tokens" description="Personal tokens let the TenderPilot Chrome extension read your bid workspaces. They act as you, in this organization."
        aside={<Button onClick={() => setOpen(true)}><KeyRound /> Create token</Button>}>
        {q.isLoading ? <SkeletonList rows={2} /> : q.isError ? <ErrorState compact error={q.error} onRetry={() => q.refetch()} /> : q.data!.items.length === 0 ? (
          <EmptyState compact icon={KeyRound} title="No tokens yet" body="Create one to connect the browser extension." />
        ) : (
          <ul className="divide-y">
            {q.data!.items.map((t) => {
              const exp = tokenExpiry(t.expiresAt);
              return (
                <li key={t.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0" data-testid="api-token-row">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><KeyRound className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-sm font-medium">{t.name}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground" title="Last 4 characters of the token">{tokenHintLabel(t.hint)}</code>
                      <Badge size="sm" tone={exp.tone} title={t.expiresAt ? `Expires ${formatDateIST(t.expiresAt)}` : undefined}>{exp.label}</Badge>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">Created {formatDateIST(t.createdAt)} · {t.lastUsedAt ? `last used ${relativeTime(t.lastUsedAt)}` : 'never used'}</span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(t)}><Trash2 /> Revoke</Button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Chrome extension — GeM co-pilot" description="Pre-fills allow-listed, non-financial fields (make, model, delivery period, warranty, MII %) on GeM bid pages, one click at a time.">
        <ol className="grid gap-3 text-sm">
          {[
            <>Build it with <code className="rounded bg-muted px-1.5 py-0.5 text-xs">pnpm --filter @tp/extension build</code> (or get the zip from your admin).</>,
            <>Open <Kbd>chrome://extensions</Kbd>, switch on <strong>Developer mode</strong> and choose <strong>Load unpacked</strong> → <code className="rounded bg-muted px-1.5 py-0.5 text-xs">apps/extension/dist</code>.</>,
            <>Click the TenderPilot icon, paste <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{origin}</code> and a token from above, then <strong>Save &amp; connect</strong>.</>,
            <>On the GeM bid page, pick the workspace and press <strong>Fill allowed fields</strong>. Review every value.</>,
          ].map((s, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary">{i + 1}</span>
              <span className="pt-0.5 text-muted-foreground [&_strong]:text-foreground">{s}</span>
            </li>
          ))}
        </ol>
        <div className="mt-5 flex gap-3 rounded-lg border border-success/25 bg-success-soft/60 p-3 text-[13px]">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
          <p><strong>You stay in control.</strong> The extension never enters prices, never touches CAPTCHA, OTP, Aadhaar, DSC or e-Sign, and never clicks submit. Those steps are always yours.</p>
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Chrome className="size-3.5" /> Works in Chrome, Edge and Brave.</div>
      </Panel>

      <CreateTokenDialog open={open} onOpenChange={setOpen} />
      <ConfirmDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)} title={`Revoke “${revoking?.name}”?`}
        description="Anything using this token (like the browser extension) stops working immediately." confirmLabel="Revoke token" loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id, { onSuccess: () => { toast.success('Token revoked'); setRevoking(null); }, onError: (e) => toast.error(errorMessage(e)) })} />
    </div>
  );
}

function CreateTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateToken();
  const [name, setName] = useState('Chrome extension');
  const [expiry, setExpiry] = useState<TokenExpiryChoice>(DEFAULT_TOKEN_EXPIRY_CHOICE);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [copied, setCopied] = useState(false);
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) setTimeout(() => { setCreated(null); setCopied(false); setName('Chrome extension'); setExpiry(DEFAULT_TOKEN_EXPIRY_CHOICE); create.reset(); }, 200);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), expiresInDays: expiresInDaysFor(expiry) }, { onSuccess: setCreated, onError: (e2) => toast.error(errorMessage(e2)) });
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Copy your new token</DialogTitle>
              <DialogDescription>This is the only time it’s shown. Store it in the extension now.</DialogDescription>
              <p className="text-xs text-muted-foreground">{created.expiresAt ? `Expires ${formatDateIST(created.expiresAt)}.` : 'Never expires.'}</p>
            </DialogHeader>
            <div className="flex gap-2">
              <Input readOnly value={created.token} aria-label="API token" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="secondary" onClick={async () => { if (await copyText(created.token)) { setCopied(true); toast.success('Token copied'); } }}>
                {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="flex items-start gap-2 text-xs text-muted-foreground"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" /> Treat it like a password. Revoke it here if it’s ever shared.</p>
            <DialogFooter><Button onClick={() => close(false)}>I’ve saved it</Button></DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Create an API token</DialogTitle>
              <DialogDescription>Give it a name you’ll recognise, like the device it’s for.</DialogDescription>
            </DialogHeader>
            <Field label="Token name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
            </Field>
            <Field label="Expires" hint={`Expired tokens stop working. You can hold up to ${API_TOKEN_LIMIT} active tokens.`}>
              <Select value={expiry} onValueChange={(v) => setExpiry(v as TokenExpiryChoice)}
                options={TOKEN_EXPIRY_OPTIONS} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => close(false)}>Cancel</Button>
              <Button type="submit" loading={create.isPending} disabled={!name.trim()}>Create token</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
