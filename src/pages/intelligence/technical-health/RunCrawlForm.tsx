import { useRef, useState } from "react";
import { Link } from "react-router";
import { apiStartCrawl } from "../../../services/api";

const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

const ERROR_TEXT: Record<string, string> = {
  NOT_VERIFIED: "Verify ownership of this website before crawling it.",
  SCAN_LIMIT_REACHED: "Your organization has reached its scan limit. Try again in a minute.",
  FORBIDDEN: "Your role cannot start scans.",
  INSUFFICIENT_ROLE: "Your role cannot start scans.",
};

/**
 * Starts a crawl-only scan with optional, lower-than-server limits. One
 * Idempotency-Key per intended submission, so a double click or a retry after
 * a network error never starts a second crawl.
 */
export function RunCrawlForm({ websiteId, disabled, onStarted }: { websiteId: string; disabled: boolean; onStarted: (scanId: string, message: string) => void }) {
  const [maxPages, setMaxPages] = useState(100);
  const [maxDepth, setMaxDepth] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const key = useRef(newKey());

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiStartCrawl(websiteId, { maxPages, maxDepth }, key.current);
      if (r.error || !r.data) {
        setError(ERROR_TEXT[r.error?.code ?? ""] ?? r.error?.message ?? "The crawl could not be started.");
        return;
      }
      setStartedId(r.data.id);
      key.current = newKey();
      onStarted(
        r.data.id,
        r.meta?.deduplicated ? "A scan of this website is already running; showing its progress." : "Crawl started.",
      );
    } catch (cause) {
      // Network failure: keep the same key so a retry cannot start a second crawl.
      setError(`The crawl could not be started: ${(cause as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} aria-labelledby="run-crawl-heading" className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 id="run-crawl-heading" className="text-sm font-700 text-slate-900">Run a technical crawl</h3>
      <p id="run-crawl-help" className="mt-1 text-xs text-slate-600">
        Fetches pages of this verified site only, honours robots.txt and reads your XML sitemap. The server's own limits always apply; these can only lower them.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-700">
          Maximum pages
          <input
            type="number" min={1} max={1000} required value={maxPages} aria-describedby="run-crawl-help"
            onChange={(e) => setMaxPages(Number(e.target.value))}
            className="mt-1 block w-28 rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-slate-700">
          Maximum link depth
          <input
            type="number" min={0} max={20} required value={maxDepth} aria-describedby="run-crawl-help"
            onChange={(e) => setMaxDepth(Number(e.target.value))}
            className="mt-1 block w-28 rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <button type="submit" disabled={disabled || busy} className="rounded-lg bg-blue-600 shadow-sm hover:bg-blue-700 px-3 py-2 text-sm font-700 text-white disabled:opacity-50">
          {busy ? "Starting…" : disabled ? "Crawl in progress" : "Start crawl"}
        </button>
        {startedId ? <Link to={`/websites/scan/${startedId}`} className="text-xs font-600 text-blue-700 underline">View scan progress</Link> : null}
      </div>
      {error ? <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p> : null}
    </form>
  );
}
