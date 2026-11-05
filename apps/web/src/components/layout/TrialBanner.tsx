/**
 * Trial banners at the top of the app shell (spec 008 FR-041a, US5 scenarios 7–8).
 *
 * - Expired trial: danger tone, every role, not dismissible — "Your free trial has ended. TenderPilot is read-only until
 *   you choose a plan." + "Talk to sales". Write actions open the plan dialog instead of calling the API (lib/api.ts).
 * - Last 7 days: info tone, Owner and Bid Manager only — "5 days left in your free trial · See plans" /
 *   "Your trial ends today"; ✕ hides it until the next IST day.
 * Only one banner at a time (expired wins). 375 px: wraps to two lines with the link on its own line.
 */
import { Link, useLocation } from 'react-router-dom';
import { Clock, Lock, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalStorage, useNow } from '@/lib/hooks';
import { SALES_MAILTO, trialBanner } from '@/lib/plan-limit';
import { cn } from '@/lib/utils';

export function TrialBanner() {
  const { me, role } = useAuth();
  const { pathname } = useLocation();
  const now = useNow(60_000);
  const [dismissed, setDismissed] = useLocalStorage<string | null>(`tp-trial-banner-dismissed:${me?.org.id ?? 'none'}`, null);
  const banner = trialBanner({ org: me?.org, role, pathname, now, dismissedDay: dismissed });
  if (!banner) return null;

  const expired = banner.kind === 'expired';
  return (
    <div
      role={expired ? 'alert' : 'status'}
      data-testid={expired ? 'trial-expired-banner' : 'trial-banner'}
      className={cn('border-b px-4 py-2.5 text-[13px] sm:px-6',
        expired ? 'border-danger/25 bg-danger-soft text-danger' : 'border-info/20 bg-info-soft text-info')}
    >
      <div className="mx-auto flex w-full max-w-[1400px] items-start gap-2.5 sm:items-center lg:px-2">
        {expired ? <Lock className="mt-0.5 size-4 shrink-0 sm:mt-0" aria-hidden /> : <Clock className="mt-0.5 size-4 shrink-0 sm:mt-0" aria-hidden />}
        <p className="flex min-w-0 flex-1 flex-col gap-0.5 font-medium sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2">
          <span className="text-foreground">{banner.text}</span>
          {expired ? (
            <a href={SALES_MAILTO} className="w-fit font-semibold underline underline-offset-2 focus-ring rounded-sm">Talk to sales</a>
          ) : (
            <>
              <span className="hidden text-muted-foreground sm:inline" aria-hidden>·</span>
              <Link to="/settings/usage" className="w-fit font-semibold underline underline-offset-2 focus-ring rounded-sm">See plans</Link>
            </>
          )}
        </p>
        {banner.kind === 'ending' && (
          <button
            type="button"
            onClick={() => setDismissed(banner.dismissKey)}
            className="-my-1 -mr-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-card/60 hover:text-foreground focus-ring"
            aria-label="Dismiss until tomorrow"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
