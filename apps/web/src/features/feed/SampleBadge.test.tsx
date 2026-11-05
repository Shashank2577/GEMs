import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { SampleBadge } from './SampleBadge';

describe('SampleBadge (007/FR-067)', () => {
  it('renders the "Sample" label', () => {
    expect(renderToStaticMarkup(<TooltipProvider><SampleBadge /></TooltipProvider>)).toContain('Sample');
  });
});
