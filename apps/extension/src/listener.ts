/**
 * Message listener for the content script (006/FR-073). Only messages sent by this extension's own
 * pages (popup) are honoured: `sender.id` must equal `chrome.runtime.id`. A web page cannot forge
 * `sender.id`, so a GeM page script can never trigger scan / fill / clear.
 */
import type { ContentRequest, ContentResponse } from './messages';
import type { FillReport, PayloadField } from './fill';
import type { ScanSummary } from './messages';

export interface ContentActions {
  scan(fields: PayloadField[]): ScanSummary;
  fill(msg: { fields: PayloadField[]; keys?: string[]; overwrite?: boolean }): FillReport;
  clear(): void;
}

export interface MessageSender { id?: string }

export function makeMessageListener(runtimeId: string | undefined, actions: ContentActions) {
  return (msg: ContentRequest, sender: MessageSender, respond: (r: ContentResponse) => void): boolean => {
    // Ignore (no response, no side effect) anything not from this extension.
    if (!runtimeId || sender?.id !== runtimeId) return false;
    try {
      if (msg?.type === 'tp:scan') respond({ ok: true, scan: actions.scan(msg.fields) });
      else if (msg?.type === 'tp:fill') respond({ ok: true, report: actions.fill(msg) });
      else if (msg?.type === 'tp:clear') { actions.clear(); respond({ ok: true }); }
    } catch (e) {
      respond({ ok: false, error: (e as Error).message });
    }
    return false;
  };
}
