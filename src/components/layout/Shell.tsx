import { useEffect, useState } from "react";
import { Outlet, NavLink, useLocation, useNavigate } from "react-router";
import {
  LayoutDashboard, Globe, Search,
  FlaskConical, Server, Bot, FileBarChart, Activity,
  ChevronDown, ChevronRight, Plus, Bell, User,
  Lock, Network, FileText, Cog, ChevronLeft
} from "lucide-react";
import { apiListWebsites } from "../../services/api";

interface NavItem {
  label: string;
  path: string;
  icon?: React.ReactNode;
}

interface NavGroup {
  label: string;
  icon: React.ReactNode;
  items: NavItem[];
  basePath: string;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Websites",
    icon: <Globe size={15} />,
    basePath: "/websites",
    items: [
      { label: "My Websites", path: "/websites" },
      { label: "Add Website", path: "/websites/add" },
      { label: "Scan History", path: "/websites/history" },
    ],
  },
  {
    label: "Intelligence",
    icon: <Search size={15} />,
    basePath: "/intelligence",
    items: [
      { label: "SEO", path: "/intelligence/seo" },
      { label: "AI Visibility", path: "/intelligence/ai-visibility" },
      { label: "Security", path: "/intelligence/security" },
      { label: "Performance", path: "/intelligence/performance" },
      { label: "Accessibility", path: "/intelligence/accessibility" },
      { label: "Technical Health", path: "/intelligence/technical-health" },
    ],
  },
  {
    label: "Testing",
    icon: <FlaskConical size={15} />,
    basePath: "/testing",
    items: [
      { label: "Browser Tests", path: "/testing/browser" },
      { label: "Regression", path: "/testing/regression" },
      { label: "Test Results", path: "/testing/results" },
    ],
  },
  {
    label: "Infrastructure",
    icon: <Server size={15} />,
    basePath: "/infrastructure",
    items: [
      { label: "SSL / HTTPS", path: "/infrastructure/ssl" },
      { label: "Certificates", path: "/infrastructure/certificates" },
      { label: "Domains", path: "/infrastructure/domains" },
    ],
  },
  {
    label: "AI Agents",
    icon: <Bot size={15} />,
    basePath: "/agents",
    items: [
      { label: "Control Center", path: "/agents/control-center" },
      { label: "Agent Registry", path: "/agents/agent-registry" },
      { label: "Model Router", path: "/agents/model-router" },
      { label: "Model Registry", path: "/agents/model-registry" },
      { label: "Model Benchmarks", path: "/agents/model-benchmarks" },
      { label: "Instructions", path: "/agents/instructions" },
      { label: "Evidence", path: "/agents/evidence" },
      { label: "Quality Control", path: "/agents/quality-control" },
    ],
  },
  {
    label: "Reports",
    icon: <FileBarChart size={15} />,
    basePath: "/reports",
    items: [
      { label: "Reports", path: "/reports" },
      { label: "Client Reports", path: "/reports/client" },
    ],
  },
  {
    label: "Monitoring",
    icon: <Activity size={15} />,
    basePath: "/monitoring",
    items: [
      { label: "Website Health", path: "/monitoring" },
      { label: "Changes", path: "/monitoring/changes" },
      { label: "Alerts", path: "/monitoring/alerts" },
    ],
  },
  {
    label: "Settings",
    icon: <Cog size={15} />,
    basePath: "/settings",
    items: [
      { label: "Workspace", path: "/settings/workspace" },
      { label: "Team", path: "/settings/team" },
      { label: "Security", path: "/settings/security" },
      { label: "API", path: "/settings/api" },
      { label: "Integrations", path: "/settings/integrations" },
    ],
  },
];

function SidebarGroup({ group, defaultOpen }: { group: NavGroup; defaultOpen: boolean }) {
  const location = useLocation();
  const isActive = location.pathname.startsWith(group.basePath);
  const [open, setOpen] = useState(defaultOpen || isActive);

  return (
    <div className="mb-0.5">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded text-left transition-colors hover:bg-white/5"
        style={{ color: isActive ? "#fff" : "var(--sidebar-text)" }}
      >
        <span style={{ color: isActive ? "#60a5fa" : "var(--sidebar-text)" }}>{group.icon}</span>
        <span className="flex-1 text-xs font-600 tracking-wide uppercase">{group.label}</span>
        <span style={{ color: "var(--sidebar-text)", opacity: 0.5 }}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {open && (
        <div className="ml-4 pl-3 border-l border-white/10 mt-0.5 mb-1">
          {group.items.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === group.basePath}
              className={({ isActive }) =>
                `block px-2 py-1.5 rounded text-xs transition-colors ${
                  isActive
                    ? "text-white bg-blue-600/20 font-500"
                    : "text-slate-400 hover:text-slate-200 hover:bg-white/5 font-400"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <aside
      className="app-sidebar flex flex-col flex-shrink-0 h-full overflow-hidden transition-all duration-200"
      style={{
        width: collapsed ? "56px" : "224px",
        background: "var(--sidebar-bg)",
        borderRight: "1px solid var(--sidebar-border)",
      }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-3 h-14 flex-shrink-0" style={{ borderBottom: "1px solid var(--sidebar-border)" }}>
        <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, #1d4ed8, #3b82f6)" }}>
          <Network size={14} className="text-white" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-white font-700 text-sm leading-tight truncate">ZigmaNeural</div>
            <div className="text-xs font-400 truncate" style={{ color: "var(--sidebar-text)", fontSize: "10px" }}>Website Intelligence</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-2 scroll-area" style={{ scrollbarWidth: "thin" }}>
        {!collapsed && (
          <>
            {/* Overview */}
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded mb-1 text-sm transition-colors ${
                  isActive
                    ? "bg-blue-600/20 text-white font-600"
                    : "text-slate-400 hover:text-white hover:bg-white/5"
                }`
              }
            >
              <LayoutDashboard size={15} style={{ color: location.pathname === "/" ? "#60a5fa" : "inherit" }} />
              <span>Overview</span>
            </NavLink>

            {NAV_GROUPS.map((group) => (
              <SidebarGroup
                key={group.basePath}
                group={group}
                defaultOpen={["Websites", "AI Agents", "Intelligence"].includes(group.label)}
              />
            ))}
          </>
        )}

        {collapsed && (
          <div className="flex flex-col items-center gap-1 pt-1">
            <NavLink to="/" end className={({ isActive }) => `p-2 rounded ${isActive ? "bg-blue-600/20 text-blue-400" : "text-slate-500 hover:text-white hover:bg-white/5"}`}>
              <LayoutDashboard size={16} />
            </NavLink>
            <NavLink to="/websites" className={({ isActive }) => `p-2 rounded ${isActive ? "bg-blue-600/20 text-blue-400" : "text-slate-500 hover:text-white hover:bg-white/5"}`}>
              <Globe size={16} />
            </NavLink>
            <NavLink to="/intelligence/seo" className={({ isActive }) => `p-2 rounded ${isActive ? "bg-blue-600/20 text-blue-400" : "text-slate-500 hover:text-white hover:bg-white/5"}`}>
              <Search size={16} />
            </NavLink>
            <NavLink to="/agents/control-center" className={({ isActive }) => `p-2 rounded ${isActive ? "bg-blue-600/20 text-blue-400" : "text-slate-500 hover:text-white hover:bg-white/5"}`}>
              <Bot size={16} />
            </NavLink>
            <NavLink to="/infrastructure/ssl" className={({ isActive }) => `p-2 rounded ${isActive ? "bg-blue-600/20 text-blue-400" : "text-slate-500 hover:text-white hover:bg-white/5"}`}>
              <Lock size={16} />
            </NavLink>
            <NavLink to="/reports" className={({ isActive }) => `p-2 rounded ${isActive ? "bg-blue-600/20 text-blue-400" : "text-slate-500 hover:text-white hover:bg-white/5"}`}>
              <FileText size={16} />
            </NavLink>
            <NavLink to="/monitoring" className={({ isActive }) => `p-2 rounded ${isActive ? "bg-blue-600/20 text-blue-400" : "text-slate-500 hover:text-white hover:bg-white/5"}`}>
              <Activity size={16} />
            </NavLink>
          </div>
        )}
      </nav>

      {/* Account context — populated by authentication flows, never sample data. */}
      {!collapsed && (
        <div className="p-3 flex-shrink-0" style={{ borderTop: "1px solid var(--sidebar-border)" }}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "#1e3a5f" }}>
              <User size={13} className="text-blue-300" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-white text-xs font-500 truncate">Authenticated workspace</div>
              <div className="text-xs truncate" style={{ color: "var(--sidebar-text)", fontSize: "10px" }}>Account context is managed securely</div>
            </div>
          </div>
        </div>
      )}

      {/* Collapse toggle */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-center py-2 transition-colors hover:bg-white/5"
        style={{ color: "var(--sidebar-text)", borderTop: "1px solid var(--sidebar-border)" }}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>
    </aside>
  );
}

function TopBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [websites, setWebsites] = useState<Array<{ id: string; domain: string }>>([]);
  const [selectedId, setSelectedId] = useState("");
  useEffect(() => {
    void apiListWebsites().then((result) => {
      if (result.data) { setWebsites(result.data as Array<{ id: string; domain: string }>); setSelectedId((result.data as Array<{ id: string; domain: string }>)[0]?.id ?? ""); }
    }).catch(() => {});
  }, []);

  const getTitle = () => {
    const path = location.pathname;
    if (path === "/") return "Overview";
    if (path === "/websites") return "My Websites";
    if (path === "/websites/add") return "Add Website";
    if (path.startsWith("/websites/scan")) return "Scan Progress";
    if (path === "/websites/history") return "Scan History";
    if (path === "/intelligence/seo") return "SEO Intelligence";
    if (path === "/intelligence/ai-visibility") return "AI Visibility";
    if (path === "/intelligence/security") return "Security";
    if (path === "/intelligence/performance") return "Performance";
    if (path === "/intelligence/accessibility") return "Accessibility";
    if (path === "/intelligence/technical-health") return "Technical Health";
    if (path === "/agents/control-center") return "AI Agent Control Center";
    if (path === "/agents/agent-registry") return "Agent Registry";
    if (path === "/agents/model-router") return "Model Router";
    if (path === "/agents/model-registry") return "Model Registry";
    if (path === "/agents/model-benchmarks") return "Model Benchmarks";
    if (path === "/agents/instructions") return "Instruction Intelligence";
    if (path === "/agents/quality-control") return "Quality Control";
    if (path === "/agents/evidence") return "Evidence Intelligence";
    if (path === "/infrastructure/ssl") return "SSL / HTTPS";
    if (path === "/infrastructure/certificates") return "Certificates";
    if (path === "/infrastructure/domains") return "Domains";
    if (path === "/reports") return "Reports";
    if (path === "/reports/client") return "Client Reports";
    if (path === "/monitoring") return "Website Health";
    if (path === "/monitoring/changes") return "Change Detection";
    if (path === "/monitoring/alerts") return "Alerts";
    if (path.startsWith("/settings")) return "Settings";
    if (path.startsWith("/testing")) return "Testing";
    return "ZigmaNeural";
  };

  return (
    <header className="app-topbar flex items-center gap-4 px-6 h-14 flex-shrink-0 bg-white" style={{ borderBottom: "1px solid var(--border)" }}>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <h1 className="app-topbar-title font-700 tracking-[-0.01em] text-slate-900 text-base truncate">{getTitle()}</h1>
      </div>

      {/* Website selector */}
      <label className="hidden md:flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5">
        <span className="sr-only">Selected website</span>
        <Globe size={14} className="text-blue-600" />
        <select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); navigate(event.target.value ? `/?websiteId=${event.target.value}` : "/"); }} className="max-w-44 bg-transparent text-sm font-600 text-slate-700 outline-none">
          <option value="">No website selected</option>{websites.map((website) => <option key={website.id} value={website.id}>{website.domain}</option>)}
        </select>
      </label>

      <div className="flex items-center gap-1.5">
        <button className="w-8 h-8 rounded-md flex items-center justify-center text-slate-400 hover:bg-slate-100 transition-colors relative">
          <Bell size={16} />
          <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500" />
        </button>
        <button
          onClick={() => navigate("/websites/add")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-600 text-white transition-colors hover:opacity-90"
          style={{ background: "var(--primary)" }}
        >
          <Plus size={14} />
          <span>New Scan</span>
        </button>
      </div>
    </header>
  );
}

export function Shell() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-full overflow-hidden bg-background">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <div className="app-main flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto scroll-area">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
