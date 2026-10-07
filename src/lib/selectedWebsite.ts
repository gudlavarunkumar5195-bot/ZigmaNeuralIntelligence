import { useSyncExternalStore } from "react";

/**
 * Shared "selected website" state. Persisted in sessionStorage so every page
 * (Overview, findings, reports, history) reads the same selection the
 * top-bar selector writes.
 */
const KEY = "zn_selected_website";
const EVENT = "zn:selected-website";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function getSelectedWebsiteId(): string | undefined {
  return storage()?.getItem(KEY) || undefined;
}

export function setSelectedWebsiteId(id?: string | null): void {
  const store = storage();
  if (!store) return;
  if (id) store.setItem(KEY, id);
  else store.removeItem(KEY);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

export function useSelectedWebsiteId(): string | undefined {
  return useSyncExternalStore(subscribe, getSelectedWebsiteId, () => undefined);
}
