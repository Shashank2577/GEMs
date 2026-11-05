/** Dev-only component gallery at /dev/ui. Not included in production builds. */
import { useState } from 'react';
import { FileStack, IndianRupee, Radar, ShieldCheck, Timer, Trash2 } from 'lucide-react';
import {
  Avatar, AvatarGroup, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, ConfirmDialog, Countdown,
  EmptyState, ErrorState, Field, FileDropzone, Input, Kbd, PageHeader, Progress, ResponsiveTable, ScoreRing, Segmented, Select,
  Skeleton, SkeletonList, Sparkline, StageBadge, StatTile, Stepper, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, Tooltip,
  VerdictBadge, toast,
} from '@/components/ui';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { formatDateIST, formatINR, relativeTime } from '@/lib/format';
import { STAGES } from '@/lib/types';

const rows = [
  { id: '1', title: 'Supply of Desktop Computers', ministry: 'Ministry of Defence', value: 24000000, end: new Date(Date.now() + 52 * 3600e3).toISOString(), score: 84 },
  { id: '2', title: 'AMC for CCTV Surveillance', ministry: 'Ministry of Railways', value: 4500000, end: new Date(Date.now() + 9 * 3600e3).toISOString(), score: 58 },
  { id: '3', title: 'Hiring of Manpower Services', ministry: 'Ministry of Home Affairs', value: 125000000, end: new Date(Date.now() + 8 * 86400e3).toISOString(), score: 31 },
];

export default function UiGallery() {
  const [seg, setSeg] = useState<'all' | 'matched' | 'saved'>('all');
  const [sel, setSel] = useState('mh');
  const [files, setFiles] = useState<File[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [leave, setLeave] = useState(false);
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <PageHeader title="Design system" description="TenderPilot UI kit — tokens and components." breadcrumbs={[{ label: 'Dev', to: '/' }, { label: 'UI' }]} actions={<ThemeToggle />} />
      <div className="grid gap-8">
        <section className="flex flex-wrap gap-2">
          {(['primary', 'secondary', 'outline', 'ghost', 'subtle', 'accent', 'success', 'danger', 'link'] as const).map((v) => <Button key={v} variant={v}>{v}</Button>)}
          <Button loading>Saving</Button>
          <Button size="sm" onClick={() => toast.success('Watchlist saved', { description: '12 tenders match right now' })}>Toast</Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm(true)}><Trash2 />Delete</Button>
          <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete document?" description="This removes it from all packets." confirmLabel="Delete" onConfirm={() => setConfirm(false)} />
          <Button size="sm" variant="outline" onClick={() => setLeave(true)}>Leave page</Button>
          {/* cancelLabel: rename the safe action (it gets initial focus) */}
          <ConfirmDialog open={leave} onOpenChange={setLeave} title="Discard unsaved changes?" cancelLabel="Stay" confirmLabel="Discard and leave" onConfirm={() => setLeave(false)} />
        </section>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="New matches today" value="18" delta={12} deltaLabel="vs yesterday" icon={Radar} sparkline={<Sparkline data={[3, 5, 4, 8, 6, 11, 18]} />} />
          <StatTile label="Closing this week" value="7" icon={Timer} tone="warning" hint="2 within 24h" />
          <StatTile label="EMD at stake" value={formatINR(4550000, { compact: true })} icon={IndianRupee} tone="accent" />
          <StatTile label="Docs expiring" value="3" delta={-25} invertDelta icon={ShieldCheck} tone="danger" loading />
        </section>
        <section className="flex flex-wrap items-center gap-6">
          <ScoreRing score={84} size={96} label="Score" />
          <ScoreRing score={58} size={64} />
          <ScoreRing score={31} size={48} />
          <ScoreRing score={null} size={48} />
          <div className="flex flex-wrap gap-2"><VerdictBadge verdict="go" /><VerdictBadge verdict="review" /><VerdictBadge verdict="no_go" /></div>
          <div className="flex flex-wrap gap-2">{STAGES.map((s) => <StageBadge key={s} stage={s} size="sm" />)}</div>
          <div className="flex flex-wrap gap-2">{(['neutral', 'primary', 'accent', 'success', 'warning', 'danger', 'info', 'outline'] as const).map((t) => <Badge key={t} tone={t}>{t}</Badge>)}</div>
        </section>
        <section className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Form controls</CardTitle><CardDescription>Field wires label, hint and error.</CardDescription></CardHeader>
            <CardContent className="grid gap-4">
              <Field label="GSTIN" hint="15 characters, e.g. 27AAACS1234F1Z5" required><Input placeholder="27AAACS1234F1Z5" /></Field>
              <Field label="PAN" error="PAN must look like ABCDE1234F"><Input defaultValue="ABC" /></Field>
              <Field label="State"><Select value={sel} onValueChange={setSel} options={[{ value: 'mh', label: 'Maharashtra' }, { value: 'ka', label: 'Karnataka' }, { value: 'dl', label: 'Delhi' }]} /></Field>
              <Field label="Notes"><Textarea placeholder="Anything the bid team should know" /></Field>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-sm"><Checkbox defaultChecked /> MSE exemption</label>
                <label className="flex items-center gap-2 text-sm"><Switch defaultChecked /> WhatsApp alerts</label>
              </div>
              <Segmented aria-label="Filter" value={seg} onChange={setSeg} options={[{ value: 'all', label: 'All' }, { value: 'matched', label: 'Matched' }, { value: 'saved', label: 'Saved' }]} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Misc</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <Stepper current={1} steps={[{ label: 'Company' }, { label: 'Categories' }, { label: 'Documents' }, { label: 'Alerts' }]} />
              <Progress value={72} tone="auto" />
              <div className="flex items-center gap-4"><Avatar name="Priya Sharma" /><AvatarGroup people={[{ name: 'Priya Sharma' }, { name: 'Rahul Verma' }, { name: 'Anita Rao' }, { name: 'Vikram Singh' }, { name: 'Neha Gupta' }]} /></div>
              <div className="flex items-center gap-3 text-sm"><Kbd>⌘</Kbd><Kbd>K</Kbd> <Tooltip content="Earnest Money Deposit"><span className="underline decoration-dotted">EMD</span></Tooltip></div>
              <div className="flex flex-wrap gap-3">{rows.map((r) => <Countdown key={r.id} to={r.end} />)}</div>
              <p className="text-sm text-muted-foreground">{formatINR(12345678)} · {formatINR(12345678, { compact: true })} · {formatDateIST(new Date(), { time: true })} · {relativeTime(Date.now() - 3 * 3600e3)}</p>
              <FileDropzone files={files} onFiles={(f) => setFiles((x) => [...x, ...f])} onRemove={(i) => setFiles((x) => x.filter((_, j) => j !== i))} multiple />
            </CardContent>
          </Card>
        </section>
        <Tabs defaultValue="table">
          <TabsList><TabsTrigger value="table">Table</TabsTrigger><TabsTrigger value="states">States</TabsTrigger><TabsTrigger value="skeleton">Skeleton</TabsTrigger></TabsList>
          <TabsContent value="table">
            <ResponsiveTable
              rows={rows}
              rowKey={(r) => r.id}
              onRowClick={() => toast('Open tender')}
              columns={[
                { key: 't', header: 'Tender', primary: true, cell: (r) => <span className="font-medium">{r.title}</span> },
                { key: 'm', header: 'Ministry', cell: (r) => r.ministry },
                { key: 'v', header: 'Value', className: 'text-right', cell: (r) => <span className="tabular">{formatINR(r.value, { compact: true })}</span> },
                { key: 'e', header: 'Closes', cell: (r) => <Countdown to={r.end} compact /> },
                { key: 's', header: 'Score', cell: (r) => <ScoreRing score={r.score} size={32} animate={false} /> },
              ]}
            />
          </TabsContent>
          <TabsContent value="states" className="grid gap-4 md:grid-cols-2">
            <EmptyState icon={FileStack} title="No tenders yet" body="Create a watchlist and we’ll alert you when matching GeM bids are published." action={<Button>Create watchlist</Button>} />
            <ErrorState error={new Error('Network unreachable')} onRetry={() => {}} />
          </TabsContent>
          <TabsContent value="skeleton" className="grid gap-4"><Skeleton className="h-8 w-48" /><SkeletonList rows={3} /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
