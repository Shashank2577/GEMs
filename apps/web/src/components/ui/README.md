# TenderPilot UI kit

Import from the barrel: `import { Button, Card, PageHeader, EmptyState, toast } from '@/components/ui';`
Dev gallery: run `pnpm --filter @tp/web dev` and open **/dev/ui** (dev builds only).

## Tokens (`src/index.css`, Tailwind names in `tailwind.config.ts`)
HSL CSS variables, light in `:root`, dark in `.dark` (class on `<html>`, managed by `useTheme()` from `@/lib/theme`).
Use Tailwind classes, never raw hex: `bg-background text-foreground`, `bg-card`, `bg-muted text-muted-foreground`, `bg-subtle`,
`border` (uses `--border`), `ring-ring`, `bg-primary text-primary-foreground`, `bg-primary-soft text-primary`,
`accent` (saffron), `success` (Go/emerald), `warning` (Review/amber), `danger` (No-Go/rose), `info`; each has a `-soft` background.
Charts: `hsl(var(--chart-1))` … `--chart-5`. Radius `rounded-lg` (10px) / `rounded-xl` cards. Shadows `shadow-xs|sm|md|lg|xl`.
Helpers: `.focus-ring`, `.surface`, `.tabular` (tabular numbers), `.bg-grid`, `.text-gradient`, `.scrollbar-thin`, `.safe-bottom`.
Spacing follows an 8px grid (`gap-2/4/6/8`, page padding is set by the AppShell — don't add outer padding in pages).

## Components
| File | Exports |
|---|---|
| button | `Button` (variant: primary·secondary·outline·ghost·subtle·accent·success·danger·link; size: xs·sm·md·lg·icon·icon-sm·icon-xs; `loading`, `block`, `asChild`) |
| input | `Input` (`leading`/`trailing` icons), `Textarea` |
| label | `Label`, `Field` (label + hint + error + required; wires `id`/`aria-*` into its single child) |
| select | `Select` (simple `options` API), plus Radix parts `SelectRoot/Trigger/Content/Item/Value` |
| checkbox | `Checkbox`, `Switch` |
| badge | `Badge` (tone: neutral·primary·accent·success·warning·danger·info·outline·solid; size sm·md·lg; `dot`) |
| card | `Card` (`interactive`), `CardHeader/Title/Description/Content/Footer` |
| dialog | `Dialog*` (size sm·md·lg·xl), `Sheet*` (side right·left·bottom·top; `SheetHeader/Body/Footer`), `ConfirmDialog` |
| tabs | `Tabs`, `TabsList` (variant underline·pill), `TabsTrigger`, `TabsContent` |
| menu | `DropdownMenu*`, `Popover*`, `Tooltip` (`content` prop) + `TooltipProvider` (mounted in App) |
| table | `Table*` primitives, `ResponsiveTable` (table ≥ md, stacked cards on phones; `columns[].primary/hideOnMobile`) |
| skeleton | `Skeleton`, `SkeletonText`, `SkeletonList`, `SkeletonPage` |
| states | `EmptyState` (icon, title, body, action), `ErrorState` (error, onRetry) |
| page-header | `PageHeader` (title, description, actions, breadcrumbs, eyebrow; sets document title), `Section` |
| stat-tile | `StatTile` (label, value, delta, icon, tone, sparkline, to, loading), `Sparkline` |
| verdict | `ScoreRing` (0–100 animated ring, colored by verdict), `VerdictBadge`, `StageBadge`, `verdictFromScore` |
| misc | `Progress` (tone auto), `Avatar`, `AvatarGroup`, `Kbd`, `Countdown` (red < 24h, amber < 3d), `Segmented`, `Stepper`, `Separator` |
| toaster | `toast` (sonner) — `toast.success('Saved')`, `toast.error(msg)`; `Toaster` is mounted in App |
| command | cmdk `Command*` + `CommandDialog` (the global ⌘K palette lives in `components/layout/CommandPalette.tsx`) |
| dropzone | `FileDropzone` (drag & drop, size check, file list with remove), `formatBytes` |

## Lib
- `@/lib/format`: `formatINR(n)` → ₹1,23,45,678; `formatINR(n, {compact:true})`/`formatINRCompact` → ₹1.2 Cr / ₹45 L; `formatDateIST(d, {time})`;
  `formatTimeIST`; `relativeTime`; `daysUntil` (IST calendar days); `countdownParts`; `formatNumberIN`; `pluralize`.
- `@/lib/api`: `api.get/post/put/patch/delete/upload`, `apiFetch`, `apiUrl` (for download links), `ApiError {status, code, details}`, `errorMessage(e)`, `queryClient`, `Paged<T>`.
- `@/lib/auth`: `useAuth()` → `{ me, role, can(min), login, signup, acceptInvite, logout, switchOrg }`, `useMe()`, `can(role, min)`, `useCan(min)`, `<RoleGate min>`, `<RequireAuth>`, `ME_KEY`.
- `@/lib/types`: `Role`, `Verdict`, `Stage`, `Me`, `STAGES`, `STAGE_LABEL`, `VERDICT_LABEL`, `ROLE_LABEL`.
- `@/lib/hooks`: `useMediaQuery`, `useIsMobile`, `useNow`, `useDocumentTitle`, `useLocalStorage`.

## Conventions for feature pages
- Default-export the page component from the exact file the router lazy-loads (see `src/app/router.tsx`).
- Start with `<PageHeader>`; show `SkeletonPage`/`SkeletonList` while loading, `ErrorState onRetry={refetch}` on error, `EmptyState` with a clear next action when empty.
- Hide write actions for viewers with `<RoleGate min="analyst">` (server still enforces roles).
- Money is integer rupees from the API → always render with `formatINR`; dates with `formatDateIST` / `Countdown`.
- Explain Indian procurement terms inline with `Tooltip` (EMD, ePBG, MII, MSE, ATC, BOQ).
- The global command palette can be opened with `window.dispatchEvent(new CustomEvent('tp:open-command'))`.
- Never add UI that enters price, solves CAPTCHA, or performs OTP/DSC on GeM (Constitution I).
