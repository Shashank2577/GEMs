import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from '@/components/ui/states';

interface State { error: Error | null }

/** Catches render errors in a page (incl. failed lazy chunk loads) without killing the shell. */
export class RouteErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Page crashed', error, info.componentStack); }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      const chunk = /dynamically imported module|Loading chunk|Failed to fetch/i.test(this.state.error.message);
      return (
        <ErrorState
          title={chunk ? 'A new version of TenderPilot is available' : 'This page hit a snag'}
          body={chunk ? 'Reload to get the latest version.' : 'Something unexpected happened while showing this page. Your data is safe.'}
          onRetry={() => (chunk ? window.location.reload() : this.setState({ error: null }))}
        />
      );
    }
    return this.props.children;
  }
}
