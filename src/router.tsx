import { lazy } from "react";
import { createHashRouter as createBrowserRouter } from "react-router";
import { Shell } from "./components/layout/Shell";

const LoginPage = lazy(() => import("./pages/auth/LoginPage").then(({ LoginPage }) => ({ default: LoginPage })));
const Overview = lazy(() => import("./pages/Overview").then(({ Overview }) => ({ default: Overview })));
const MyWebsites = lazy(() => import("./pages/websites/MyWebsites").then(({ MyWebsites }) => ({ default: MyWebsites })));
const AddWebsite = lazy(() => import("./pages/websites/AddWebsite").then(({ AddWebsite }) => ({ default: AddWebsite })));
const ScanProgress = lazy(() => import("./pages/websites/ScanProgress").then(({ ScanProgress }) => ({ default: ScanProgress })));
const ScanHistory = lazy(() => import("./pages/websites/ScanHistory").then(({ ScanHistory }) => ({ default: ScanHistory })));
const SEOPage = lazy(() => import("./pages/intelligence/SEOPage").then(({ SEOPage }) => ({ default: SEOPage })));
const SecurityPage = lazy(() => import("./pages/intelligence/SecurityPage").then(({ SecurityPage }) => ({ default: SecurityPage })));
const AIVisibilityPage = lazy(() => import("./pages/intelligence/AIVisibilityPage").then(({ AIVisibilityPage }) => ({ default: AIVisibilityPage })));
const PerformancePage = lazy(() => import("./pages/intelligence/PerformancePage").then(({ PerformancePage }) => ({ default: PerformancePage })));
const AccessibilityPage = lazy(() => import("./pages/intelligence/AccessibilityPage").then(({ AccessibilityPage }) => ({ default: AccessibilityPage })));
const TechnicalHealthPage = lazy(() => import("./pages/intelligence/TechnicalHealthPage").then(({ TechnicalHealthPage }) => ({ default: TechnicalHealthPage })));
const BrowserTestsPage = lazy(() => import("./pages/testing/BrowserTestsPage").then(({ BrowserTestsPage }) => ({ default: BrowserTestsPage })));
const RegressionPage = lazy(() => import("./pages/testing/RegressionPage").then(({ RegressionPage }) => ({ default: RegressionPage })));
const TestResultsPage = lazy(() => import("./pages/testing/TestResultsPage").then(({ TestResultsPage }) => ({ default: TestResultsPage })));
const SSLPage = lazy(() => import("./pages/infrastructure/SSLPage").then(({ SSLPage }) => ({ default: SSLPage })));
const CertificatesPage = lazy(() => import("./pages/infrastructure/CertificatesPage").then(({ CertificatesPage }) => ({ default: CertificatesPage })));
const DomainsPage = lazy(() => import("./pages/infrastructure/DomainsPage").then(({ DomainsPage }) => ({ default: DomainsPage })));
const ControlCenter = lazy(() => import("./pages/agents/ControlCenter").then(({ ControlCenter }) => ({ default: ControlCenter })));
const AgentRegistry = lazy(() => import("./pages/agents/AgentRegistry").then(({ AgentRegistry }) => ({ default: AgentRegistry })));
const ModelRouter = lazy(() => import("./pages/agents/ModelRouter").then(({ ModelRouter }) => ({ default: ModelRouter })));
const ModelRegistry = lazy(() => import("./pages/agents/ModelRegistry").then(({ ModelRegistry }) => ({ default: ModelRegistry })));
const ModelBenchmarks = lazy(() => import("./pages/agents/ModelBenchmarks").then(({ ModelBenchmarks }) => ({ default: ModelBenchmarks })));
const Instructions = lazy(() => import("./pages/agents/Instructions").then(({ Instructions }) => ({ default: Instructions })));
const QualityControl = lazy(() => import("./pages/agents/QualityControl").then(({ QualityControl }) => ({ default: QualityControl })));
const Evidence = lazy(() => import("./pages/agents/Evidence").then(({ Evidence }) => ({ default: Evidence })));
const ReportsPage = lazy(() => import("./pages/reports/ReportsPage").then(({ ReportsPage }) => ({ default: ReportsPage })));
const ClientReportsPage = lazy(() => import("./pages/reports/ClientReportsPage").then(({ ClientReportsPage }) => ({ default: ClientReportsPage })));
const MonitoringPage = lazy(() => import("./pages/monitoring/MonitoringPage").then(({ MonitoringPage }) => ({ default: MonitoringPage })));
const ChangesPage = lazy(() => import("./pages/monitoring/ChangesPage").then(({ ChangesPage }) => ({ default: ChangesPage })));
const AlertsPage = lazy(() => import("./pages/monitoring/AlertsPage").then(({ AlertsPage }) => ({ default: AlertsPage })));
const SettingsWorkspace = lazy(() => import("./pages/settings/SettingsWorkspace").then(({ SettingsWorkspace }) => ({ default: SettingsWorkspace })));
const SettingsTeam = lazy(() => import("./pages/settings/SettingsTeam").then(({ SettingsTeam }) => ({ default: SettingsTeam })));
const SettingsSecurity = lazy(() => import("./pages/settings/SettingsSecurity").then(({ SettingsSecurity }) => ({ default: SettingsSecurity })));
const SettingsAPI = lazy(() => import("./pages/settings/SettingsAPI").then(({ SettingsAPI }) => ({ default: SettingsAPI })));
const SettingsIntegrations = lazy(() => import("./pages/settings/SettingsIntegrations").then(({ SettingsIntegrations }) => ({ default: SettingsIntegrations })));
const PlaceholderPage = lazy(() => import("./pages/PlaceholderPage").then(({ PlaceholderPage }) => ({ default: PlaceholderPage })));

export const router = createBrowserRouter([
  { path: "/login", Component: LoginPage },
  {
    path: "/",
    Component: Shell,
    children: [
      { index: true, Component: Overview },
      { path: "websites", Component: MyWebsites },
      { path: "websites/add", Component: AddWebsite },
      { path: "websites/scan/:id", Component: ScanProgress },
      { path: "websites/history", Component: ScanHistory },
      { path: "intelligence/seo", Component: SEOPage },
      { path: "intelligence/ai-visibility", Component: AIVisibilityPage },
      { path: "intelligence/security", Component: SecurityPage },
      { path: "intelligence/performance", Component: PerformancePage },
      { path: "intelligence/accessibility", Component: AccessibilityPage },
      { path: "intelligence/technical-health", Component: TechnicalHealthPage },
      { path: "testing/browser", Component: BrowserTestsPage },
      { path: "testing/regression", Component: RegressionPage },
      { path: "testing/results", Component: TestResultsPage },
      { path: "infrastructure/ssl", Component: SSLPage },
      { path: "infrastructure/certificates", Component: CertificatesPage },
      { path: "infrastructure/domains", Component: DomainsPage },
      { path: "agents/control-center", Component: ControlCenter },
      { path: "agents/agent-registry", Component: AgentRegistry },
      { path: "agents/model-router", Component: ModelRouter },
      { path: "agents/model-registry", Component: ModelRegistry },
      { path: "agents/model-benchmarks", Component: ModelBenchmarks },
      { path: "agents/instructions", Component: Instructions },
      { path: "agents/evidence", Component: Evidence },
      { path: "agents/quality-control", Component: QualityControl },
      { path: "reports", Component: ReportsPage },
      { path: "reports/client", Component: ClientReportsPage },
      { path: "monitoring", Component: MonitoringPage },
      { path: "monitoring/changes", Component: ChangesPage },
      { path: "monitoring/alerts", Component: AlertsPage },
      { path: "settings/workspace", Component: SettingsWorkspace },
      { path: "settings/team", Component: SettingsTeam },
      { path: "settings/security", Component: SettingsSecurity },
      { path: "settings/api", Component: SettingsAPI },
      { path: "settings/integrations", Component: SettingsIntegrations },
      { path: "*", Component: PlaceholderPage },
    ],
  },
]);
