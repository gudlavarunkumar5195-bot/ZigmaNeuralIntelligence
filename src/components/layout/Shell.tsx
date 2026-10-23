import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router";
import { Bell, ChevronDown, ChevronRight, Globe, LogOut, Menu, Network, PanelLeftClose, PanelLeftOpen, Plus, Search, User, X } from "lucide-react";
import { apiGetMe, apiListAlerts, apiListWebsites, apiLogout, clearSession, getActiveOrgId, isAuthenticated } from "../../services/api";
import { getSelectedWebsiteId, setSelectedWebsiteId } from "../../lib/selectedWebsite";
import { ToastProvider } from "../ui/Toast";
import { Tooltip } from "../ui/Tooltip";
import { buttonClass } from "../ui/styles";
import { findRoute, isGroupActive, NAV_GROUPS, routeTitle, type NavGroup } from "./navigation";

const WEBSITE_PAGE_SIZE = 100;
const ALERT_PAGE_SIZE = 100;
const COLLAPSE_KEY = "zn_sidebar_collapsed";
const OPEN_GROUPS_KEY = "zn_sidebar_groups";

// Per-viewer UI preferences only; failures (private mode) fall back to defaults.
const readPref = <T,>(key: string, fallback: T): T => {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
const writePref = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* preferences are optional */
  }
};

function useAccount() {
  const [email, setEmail] = useState<string | null>(null);
  // Only hides navigation; every admin endpoint enforces platform-admin access itself.
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  // Role in the active organization: display only (viewers are told up front that changes are disabled).
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void apiGetMe()
      .then((result) => {
        if (!active) return;
        if (result.data?.email) setEmail(result.data.email);
        setIsPlatformAdmin(result.data?.isPlatformAdmin === true);
        const activeOrg = getActiveOrgId();
        setRole(result.data?.memberships?.find((m) => m.orgId === activeOrg)?.role ?? null);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  return { email, isPlatformAdmin, role };
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function NavSection({ group, open, onToggle, onNavigate }: { group: NavGroup; open: boolean; onToggle: () => void; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const active = isGroupActive(group, pathname);
  const Icon = group.icon;
  const listId = `nav-${group.id}`;
  return (
    <div className="mb-0.5">
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={listId}
        className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${active ? "text-white" : "text-[var(--zn-sidebar-text)] hover:bg-white/5 hover:text-white"}`}>
        <Icon size={16} aria-hidden="true" className={active ? "text-[var(--zn-sidebar-accent)]" : ""} />
        <span className="flex-1 truncate">{group.label}</span>
        <ChevronDown size={14} aria-hidden="true" className={`opacity-60 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open ? (
        <ul id={listId} className="mb-2 ml-[19px] mt-0.5 space-y-px border-l border-[var(--zn-sidebar-border)] pl-2.5">
          {group.items.map((item) => (
            <li key={item.path}>
              <NavLink to={item.path} end={!item.prefix} onClick={onNavigate}
                className={({ isActive }) => `group relative flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${isActive ? "bg-[var(--zn-sidebar-active)] font-600 text-white before:absolute before:-left-[11px] before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-[var(--zn-sidebar-accent)]" : "text-[var(--zn-sidebar-text)] hover:bg-white/5 hover:text-white"}`}>
                <span className="flex-1 truncate">{item.label}</span>
                {item.unavailable ? <span className="rounded bg-white/10 px-1 py-px text-[9px] font-600 uppercase tracking-wide text-[var(--zn-sidebar-text)]" title="Not available yet">N/A</span> : null}
              </NavLink>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SidebarNav({ isPlatformAdmin, onNavigate }: { isPlatformAdmin: boolean; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const groups = NAV_GROUPS.filter((g) => !g.adminOnly || isPlatformAdmin);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => readPref(OPEN_GROUPS_KEY, { overview: true, research: true, intelligence: true, websites: true }));
  // An explicit choice wins; otherwise the group of the current page is open.
  const isOpen = (g: NavGroup) => openGroups[g.id] ?? isGroupActive(g, pathname);
  const toggle = (g: NavGroup) => setOpenGroups((s) => {
    const next = { ...s, [g.id]: !isOpen(g) };
    writePref(OPEN_GROUPS_KEY, next);
    return next;
  });
  return (
    <>
      <nav aria-label="Primary" className="scroll-area flex-1 overflow-y-auto px-2 py-3">
        {groups.filter((g) => !g.secondary).map((g) => <NavSection key={g.id} group={g} open={isOpen(g)} onToggle={() => toggle(g)} onNavigate={onNavigate} />)}
      </nav>
      <nav aria-label="Settings and administration" className="border-t border-[var(--zn-sidebar-border)] px-2 py-2">
        {groups.filter((g) => g.secondary).map((g) => <NavSection key={g.id} group={g} open={isOpen(g)} onToggle={() => toggle(g)} onNavigate={onNavigate} />)}
      </nav>
    </>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    // The accessible name starts with the visible text (WCAG 2.5.3); the icon-only form needs a label.
    <Link to="/" className="flex min-w-0 items-center gap-2.5 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400" aria-label={compact ? "ZigmaNeural Intelligence home" : undefined}>
      <span className="brand-highlight flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg"><Network size={16} className="text-white" aria-hidden="true" /></span>
      {compact ? null : (
        <span className="min-w-0">
          <span className="block truncate text-sm font-800 leading-tight text-white">ZigmaNeural</span>
          <span className="block truncate text-[10px] font-600 uppercase tracking-[0.14em] text-[var(--zn-sidebar-text)]">Intelligence<span className="sr-only"> home</span></span>
        </span>
      )}
    </Link>
  );
}

function Account({ email, role }: { email: string | null; role?: string | null }) {
  return (
    <div className="border-t border-[var(--zn-sidebar-border)] p-3">
      <div className="flex items-center gap-2.5 rounded-lg bg-white/5 p-2">
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--zn-sidebar-raised)] text-[var(--zn-sidebar-text)]"><User size={13} aria-hidden="true" /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-600 text-white" data-testid="account-email">{email ?? "Signed in"}</span>
          <span className="block text-[10px] tracking-[0.08em] text-[var(--zn-sidebar-text)]">{role ? `${role.toUpperCase()} · ` : ""}VERSION {__APP_VERSION__}</span>
        </span>
      </div>
    </div>
  );
}

/** Icon rail for the collapsed sidebar: each group opens its first page; names appear as tooltips. */
function Rail({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const { pathname } = useLocation();
  const groups = NAV_GROUPS.filter((g) => !g.adminOnly || isPlatformAdmin);
  return (
    <nav aria-label="Primary" className="scroll-area flex flex-1 flex-col items-center gap-1 overflow-y-auto py-3">
      {groups.map((g) => {
        const Icon = g.icon;
        const active = isGroupActive(g, pathname);
        return (
          <Tooltip key={g.id} content={g.label} side="right">
            <NavLink to={g.items[0].path} aria-label={g.label} aria-current={active ? "page" : undefined}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${active ? "bg-[var(--zn-sidebar-active)] text-white" : "text-[var(--zn-sidebar-text)] hover:bg-white/5 hover:text-white"}`}>
              <Icon size={17} aria-hidden="true" />
            </NavLink>
          </Tooltip>
        );
      })}
    </nav>
  );
}

function Sidebar({ collapsed, onToggle, email, role, isPlatformAdmin }: { collapsed: boolean; onToggle: () => void; email: string | null; role: string | null; isPlatformAdmin: boolean }) {
  return (
    <aside aria-label="Sidebar" className="hidden print:!hidden h-full flex-shrink-0 flex-col border-r border-[var(--zn-sidebar-border)] bg-[var(--zn-sidebar)] transition-[width] duration-200 lg:flex"
      style={{ width: collapsed ? "var(--zn-sidebar-collapsed)" : "var(--zn-sidebar-width)" }}>
      <div className={`flex h-[var(--zn-topbar-height)] flex-shrink-0 items-center border-b border-[var(--zn-sidebar-border)] ${collapsed ? "justify-center px-2" : "px-4"}`}>
        <Brand compact={collapsed} />
      </div>
      {collapsed ? <Rail isPlatformAdmin={isPlatformAdmin} /> : <SidebarNav isPlatformAdmin={isPlatformAdmin} />}
      {collapsed ? null : <Account email={email} role={role} />}
      <button type="button" onClick={onToggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-pressed={collapsed}
        className="flex h-10 flex-shrink-0 items-center justify-center gap-2 border-t border-[var(--zn-sidebar-border)] text-xs text-[var(--zn-sidebar-text)] transition-colors hover:bg-white/5 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400">
        {collapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <><PanelLeftClose size={16} aria-hidden="true" /><span>Collapse</span></>}
      </button>
    </aside>
  );
}

/** Off-canvas navigation for screens narrower than 1024px. */
function MobileDrawer({ onClose, email, role, isPlatformAdmin }: { onClose: () => void; email: string | null; role: string | null; isPlatformAdmin: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (!document.querySelector("dialog[open]")) onClose(); return; }
      // aria-modal: keep Tab focus inside the drawer.
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 bg-slate-950/50 [animation:zn-fade-in_.15s_ease-out]" onClick={onClose} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Navigation" className="absolute inset-y-0 left-0 flex w-[min(86vw,300px)] flex-col bg-[var(--zn-sidebar)] shadow-2xl [animation:zn-drawer-in_.2s_ease-out]">
        <div className="flex h-[var(--zn-topbar-height)] items-center justify-between border-b border-[var(--zn-sidebar-border)] px-4">
          <Brand />
          <button type="button" onClick={onClose} aria-label="Close navigation" className="rounded-md p-1.5 text-[var(--zn-sidebar-text)] hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><X size={18} aria-hidden="true" /></button>
        </div>
        <SidebarNav isPlatformAdmin={isPlatformAdmin} onNavigate={onClose} />
        <Account email={email} role={role} />
      </div>
    </div>
  );
}

// ─── Command launcher ────────────────────────────────────────────────────────

/** Jump to any page by name (Ctrl/⌘ K). Lists real routes only. */
function CommandLauncher({ onClose, isPlatformAdmin }: { onClose: () => void; isPlatformAdmin: boolean }) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const items = useMemo(() => NAV_GROUPS.filter((g) => !g.adminOnly || isPlatformAdmin).flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))), [isPlatformAdmin]);
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (t ? items.filter((i) => `${i.label} ${i.group} ${i.keywords ?? ""}`.toLowerCase().includes(t)) : items).slice(0, 12);
  }, [q, items]);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    }
  }, []);
  const go = (path: string) => { onClose(); navigate(path); };
  return (
    <dialog ref={ref} aria-label="Go to page" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-lg rounded-xl border border-slate-200 bg-white p-0 shadow-2xl">
      <div className="flex items-center gap-2 border-b border-slate-200 px-3">
        <Search size={16} className="text-slate-400" aria-hidden="true" />
        <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setIndex(0); }} placeholder="Go to page…" aria-label="Search pages" aria-controls="zn-command-results"
          aria-activedescendant={results[index] ? `zn-cmd-${index}` : undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            if (e.key === "Enter" && results[index]) go(results[index].path);
          }}
          className="h-12 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400" />
        <kbd className="rounded border border-slate-200 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">Esc</kbd>
      </div>
      <ul id="zn-command-results" role="listbox" aria-label="Pages" className="max-h-80 overflow-y-auto p-1.5">
        {results.length === 0 ? <li className="px-3 py-6 text-center text-xs text-slate-500">No page matches “{q}”.</li> : results.map((r, i) => (
          <li key={r.path} id={`zn-cmd-${i}`} role="option" aria-selected={i === index}>
            <button type="button" tabIndex={-1} onMouseEnter={() => setIndex(i)} onClick={() => go(r.path)} className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-[13px] ${i === index ? "bg-blue-50 text-blue-800" : "text-slate-700"}`}>
              <span><span className="font-600">{r.label}</span><span className="ml-2 text-[11px] text-slate-500">{r.group}</span></span>
              {r.unavailable ? <span className="text-[10px] font-600 uppercase text-slate-500">Not available</span> : <ChevronRight size={14} aria-hidden="true" className="text-slate-400" />}
            </button>
          </li>
        ))}
      </ul>
    </dialog>
  );
}

// ─── Top bar ─────────────────────────────────────────────────────────────────

function TopBar({ onOpenMenu, onOpenCommand, onLogout, loggingOut }: { onOpenMenu: () => void; onOpenCommand: () => void; onLogout: () => void; loggingOut: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlWebsiteId = searchParams.get("websiteId") ?? "";
  const [websites, setWebsites] = useState<Array<{ id: string; domain: string }>>([]);
  const [truncated, setTruncated] = useState(false);
  const [websitesError, setWebsitesError] = useState(false);
  const [selectedId, setSelectedId] = useState(urlWebsiteId || getSelectedWebsiteId() || "");
  const [openAlerts, setOpenAlerts] = useState<{ count: number; more: boolean } | null>(null);
  const onAlertsPage = location.pathname === "/monitoring/alerts";
  useEffect(() => {
    if (!isAuthenticated()) {
      navigate("/login", { replace: true });
      return;
    }
    void apiListWebsites({ pageSize: WEBSITE_PAGE_SIZE }).then((result) => {
      const list = result.data;
      setWebsitesError(!list);
      if (!list) return;
      const isTruncated = list.length >= (result.meta?.pageSize ?? WEBSITE_PAGE_SIZE);
      setWebsites(list);
      setTruncated(isTruncated);
      // A shared selection that is not in the (complete) list is stale, e.g. a
      // deleted site: replace it, so no page keeps asking for it.
      const shared = getSelectedWebsiteId();
      if (shared && !isTruncated && !list.some((website) => website.id === shared)) setSelectedWebsiteId(list[0]?.id ?? null);
      setSelectedId((current) => {
        if (current && list.some((website) => website.id === current)) return current;
        // Stale or absent selection: fall back to the newest site (same default the API uses).
        return list[0]?.id ?? "";
      });
    }).catch(() => setWebsitesError(true));
  }, [navigate]);
  // A ?websiteId= deep link wins and becomes the shared selection.
  useEffect(() => {
    if (urlWebsiteId) {
      setSelectedId(urlWebsiteId);
      setSelectedWebsiteId(urlWebsiteId);
    }
  }, [urlWebsiteId]);
  useEffect(() => {
    if (!isAuthenticated()) return;
    let active = true;
    void apiListAlerts({ pageSize: ALERT_PAGE_SIZE })
      .then((result) => {
        if (!active) return;
        if (result.error || !result.data) { setOpenAlerts(null); return; }
        setOpenAlerts({ count: result.data.filter((alert) => alert.status === "OPEN").length, more: result.data.length >= (result.meta?.pageSize ?? ALERT_PAGE_SIZE) });
      })
      .catch(() => { if (active) setOpenAlerts(null); });
    return () => { active = false; };
  }, [onAlertsPage]);

  const { group, title } = routeTitle(location.pathname);
  return (
    <header className="print:hidden flex h-[var(--zn-topbar-height)] flex-shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:gap-3 sm:px-5">
      <button type="button" onClick={onOpenMenu} aria-label="Open navigation" className="rounded-md p-2 text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 lg:hidden"><Menu size={18} aria-hidden="true" /></button>
      <div aria-hidden="true" className="flex-1 sm:hidden" />
      <nav aria-label="Breadcrumb" className="hidden min-w-0 flex-1 sm:block">
        <ol className="flex min-w-0 items-center gap-1.5 text-[13px]">
          {group ? <li className="hidden truncate text-slate-500 sm:block">{group}</li> : null}
          {group ? <li aria-hidden="true" className="hidden text-slate-300 sm:block"><ChevronRight size={14} /></li> : null}
          <li aria-current="page" className="truncate font-700 text-slate-900">{title}</li>
        </ol>
      </nav>

      <button type="button" onClick={onOpenCommand} className="hidden h-9 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-xs text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 xl:flex" aria-keyshortcuts="Control+K Meta+K">
        <Search size={14} aria-hidden="true" /><span>Go to page</span><kbd className="rounded border border-slate-200 bg-white px-1 font-mono text-[10px]">Ctrl K</kbd>
      </button>
      <button type="button" onClick={onOpenCommand} aria-label="Go to page" aria-keyshortcuts="Control+K Meta+K" className="rounded-md p-2 text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 xl:hidden"><Search size={17} aria-hidden="true" /></button>

      <label className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 shadow-sm sm:px-2.5">
        <span className="sr-only">Selected website</span>
        <Globe size={14} className="hidden flex-shrink-0 text-blue-600 sm:block" aria-hidden="true" />
        <select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setSelectedWebsiteId(event.target.value); navigate(event.target.value ? `/?websiteId=${event.target.value}` : "/"); }} className="w-full max-w-[7.5rem] bg-transparent text-[13px] font-600 text-slate-800 outline-none sm:max-w-44">
          <option value="">{websitesError ? "Websites unavailable" : "No website selected"}</option>{websites.map((website) => <option key={website.id} value={website.id}>{website.domain}</option>)}
        </select>
        {truncated && <span className="text-[10px] text-slate-500" data-testid="website-truncation">Showing first {WEBSITE_PAGE_SIZE}</span>}
      </label>

      <button type="button" onClick={() => navigate("/monitoring/alerts")}
        aria-label={openAlerts && openAlerts.count > 0 ? `Alerts: ${openAlerts.count}${openAlerts.more ? "+" : ""} open` : "Alerts"}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
        <Bell size={17} aria-hidden="true" />
        {openAlerts && openAlerts.count > 0 && (
          <span data-testid="open-alert-count" className="absolute -right-0.5 -top-0.5 h-4 min-w-4 rounded-full bg-red-600 px-1 text-[9px] font-700 leading-4 text-white">
            {openAlerts.count}{openAlerts.more ? "+" : ""}
          </span>
        )}
      </button>
      <button type="button" onClick={onLogout} disabled={loggingOut} className={`${buttonClass("ghost", "md")} max-xl:w-9 max-xl:px-0`}>
        <LogOut size={14} aria-hidden="true" /><span className="sr-only xl:not-sr-only">{loggingOut ? "Logging out…" : "Logout"}</span>
      </button>
      <button type="button" onClick={() => navigate("/websites/add")} className={buttonClass("primary", "md")}>
        <Plus size={14} aria-hidden="true" /><span className="hidden sm:inline">New Scan</span><span className="sr-only sm:hidden">New Scan</span>
      </button>
    </header>
  );
}

// ─── Shell ───────────────────────────────────────────────────────────────────

export function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { email, isPlatformAdmin, role } = useAccount();
  const [collapsed, setCollapsed] = useState<boolean>(() => readPref(COLLAPSE_KEY, false));
  const [drawer, setDrawer] = useState(false);
  const [command, setCommand] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  const toggleCollapsed = useCallback(() => setCollapsed((c) => { writePref(COLLAPSE_KEY, !c); return !c; }), []);
  const closeDrawer = useCallback(() => setDrawer(false), []);
  const closeCommand = useCallback(() => setCommand(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCommand(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // New page: close the drawer, scroll to top.
  useEffect(() => {
    setDrawer(false);
    mainRef.current?.scrollTo?.({ top: 0 });
  }, [location.pathname]);
  useEffect(() => {
    const r = findRoute(location.pathname);
    document.title = r ? `${r.item.label} · ZigmaNeural Intelligence` : "ZigmaNeural Intelligence";
  }, [location.pathname]);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await apiLogout();
    } finally {
      clearSession();
      setLoggingOut(false);
      navigate("/login", { replace: true });
    }
  };

  return (
    <ToastProvider>
      {/* The app uses a hash router, so the skip link moves focus instead of changing the URL hash. */}
      <a href="#zn-main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }} className="sr-only z-[70] rounded-md bg-white px-3 py-2 text-sm font-600 text-blue-700 shadow focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>
      <div className="flex h-full overflow-hidden bg-[var(--zn-bg)] print:block print:h-auto print:overflow-visible print:bg-white">
        <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} email={email} role={role} isPlatformAdmin={isPlatformAdmin} />
        {drawer ? <MobileDrawer onClose={closeDrawer} email={email} role={role} isPlatformAdmin={isPlatformAdmin} /> : null}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden print:block print:overflow-visible">
          <TopBar onOpenMenu={() => setDrawer(true)} onOpenCommand={() => setCommand(true)} onLogout={handleLogout} loggingOut={loggingOut} />
          <main id="zn-main" ref={mainRef} tabIndex={-1} className="scroll-area flex-1 overflow-y-auto print:overflow-visible print:p-0 px-4 py-5 focus:outline-none sm:px-6 lg:px-8 lg:py-6">
            <div className="mx-auto w-full max-w-[var(--zn-content-max)]">
              {role === "viewer" ? (
                <p role="note" className="mb-4 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                  You have view-only access in this organization. Owners, admins and members can make changes; actions you try will be refused.
                </p>
              ) : null}
              <Outlet />
            </div>
          </main>
        </div>
      </div>
      {command ? <CommandLauncher onClose={closeCommand} isPlatformAdmin={isPlatformAdmin} /> : null}
    </ToastProvider>
  );
}
