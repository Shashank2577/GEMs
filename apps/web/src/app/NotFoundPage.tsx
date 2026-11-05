import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/layout/Logo';
import { useDocumentTitle } from '@/lib/hooks';

export default function NotFoundPage() {
  useDocumentTitle('Page not found');
  const navigate = useNavigate();
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-background px-4 text-center">
      <div className="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black,transparent_65%)]" aria-hidden />
      <Link to="/" className="absolute left-5 top-5 rounded-md focus-ring"><Logo /></Link>
      <div className="relative">
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl border bg-card shadow-md"><Compass className="size-6 text-primary" /></span>
        <p className="mt-6 text-sm font-semibold text-primary">404</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">This page went off the map</h1>
        <p className="mx-auto mt-3 max-w-md text-muted-foreground">The link may be broken or the page may have moved. Let’s get you back to your tenders.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button variant="secondary" onClick={() => navigate(-1)}><ArrowLeft /> Go back</Button>
          <Button asChild><Link to="/dashboard">Open dashboard</Link></Button>
        </div>
      </div>
    </div>
  );
}
