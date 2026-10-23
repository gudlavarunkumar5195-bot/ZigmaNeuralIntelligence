import { useState } from "react";
import { InlineError } from "../../../components/ui/DataState";
import { ConfirmDialog } from "../../../components/ui/Dialog";
import { btn } from "../../../components/ui/styles";
import { useApiQuery } from "../../../lib/useApiQuery";
import { useBusy } from "../../../lib/useBusy";
import { apiDeleteKeywordList, apiGetKeywordList, apiListKeywordLists, apiRemoveKeywordListItem, type KeywordListSummary } from "../../../services/api";

/**
 * The organization's saved keyword lists: open one to see its keywords,
 * remove a keyword, or delete a list (with confirmation). Lists are shared by
 * the organization; viewers can read them, members and above can change them.
 */
export function SavedLists() {
  const lists = useApiQuery(() => apiListKeywordLists(), []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<KeywordListSummary | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const { busy, guard } = useBusy();

  const remove = guard(async (list: KeywordListSummary) => {
    const r = await apiDeleteKeywordList(list.id);
    setToDelete(null);
    setMessage(r.error ? { ok: false, text: r.error.message } : { ok: true, text: `Deleted the list “${list.name}”.` });
    if (!r.error && openId === list.id) setOpenId(null);
    lists.reload();
  });

  return (
    <section aria-labelledby="lists-heading" className="mt-6">
      <h3 id="lists-heading" className="text-sm font-700 text-slate-900">Saved keyword lists</h3>
      {message ? <p role={message.ok ? "status" : "alert"} className={`mt-1 text-xs ${message.ok ? "text-slate-700" : "text-red-700"}`}>{message.text}</p> : null}
      {lists.error ? <InlineError what="saved lists" error={lists.error} onRetry={lists.reload} /> : !lists.data ? <p className="mt-2 text-xs text-slate-500">Loading lists…</p> : lists.data.length === 0 ? (
        <p className="mt-2 text-xs text-slate-600">No saved lists yet. Select keywords in a research result to save them.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-xs">
          {lists.data.map((l) => (
            <li key={l.id} className="p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-600 text-slate-900">{l.name}</span>
                <span className="text-slate-500">{l.items} keyword(s) · {new Date(l.created_at).toLocaleDateString()}</span>
                <button type="button" className={`${btn} ml-auto`} aria-expanded={openId === l.id} onClick={() => setOpenId(openId === l.id ? null : l.id)}>{openId === l.id ? "Close" : "Open"}</button>
                <button type="button" className={btn} disabled={busy} onClick={() => setToDelete(l)}>Delete…</button>
              </div>
              {openId === l.id ? <ListItems listId={l.id} onChanged={lists.reload} /> : null}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!toDelete} title={`Delete “${toDelete?.name ?? ""}”?`} confirmLabel="Delete list" busy={busy}
        description="The list and its saved keywords are removed for everyone in the organization. Research results are not affected."
        onCancel={() => setToDelete(null)} onConfirm={() => { if (toDelete) void remove(toDelete); }} />
    </section>
  );
}

function ListItems({ listId, onChanged }: { listId: string; onChanged: () => void }) {
  const list = useApiQuery(() => apiGetKeywordList(listId), [listId]);
  const { busy, guard } = useBusy();
  const [error, setError] = useState<string | null>(null);
  const removeItem = guard(async (keyword: string) => {
    setError(null);
    const r = await apiRemoveKeywordListItem(listId, keyword);
    if (r.error) setError(r.error.message);
    list.reload();
    onChanged();
  });
  if (list.error) return <InlineError what="this list" error={list.error} onRetry={list.reload} />;
  if (!list.data) return <p className="mt-2 text-slate-500">Loading keywords…</p>;
  if (list.data.items.length === 0) return <p className="mt-2 text-slate-600">This list is empty.</p>;
  return (
    <>
      {error ? <p role="alert" className="mt-2 text-red-700">{error}</p> : null}
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {list.data.items.map((item) => (
          <li key={item.keyword_key} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5">
            {item.keyword}
            <button type="button" aria-label={`Remove ${item.keyword} from the list`} disabled={busy} onClick={() => void removeItem(item.keyword)} className="text-slate-500 hover:text-slate-900 disabled:opacity-50">×</button>
          </li>
        ))}
      </ul>
    </>
  );
}
