import { createHashRouter as createBrowserRouter } from "react-router";
import { Shell } from "./components/layout/Shell";
import { LoginPage } from "./pages/auth/LoginPage";
import { Overview } from "./pages/Overview";
import { MyWebsites } from "./pages/websites/MyWebsites";
import { AddWebsite } from "./pages/websites/AddWebsite";
import { ScanProgress } from "./pages/websites/ScanProgress";
import { ScanHistory } from "./pages/websites/ScanHistory";
import { SEOPage } from "./pages/intelligence/SEOPage";
import { SecurityPage } from "./pages/intelligence/SecurityPage";
import { AIVisibilityPage } from "./pages/intelligence/AIVisibilityPage";
import { PerformancePage } from "./pages/intelligence/PerformancePage";
import { AccessibilityPage } from "./pages/intelligence/AccessibilityPage";
import { TechnicalHealthPage } from "./pages/intelligence/TechnicalHealthPage";
import { BrowserTestsPage } from "./pages/testing/BrowserTestsPage";
import { RegressionPage } from "./pages/testing/RegressionPage";
import { TestResultsPage } from "./pages/testing/TestResultsPage";
import { SSLPage } from "./pages/infrastructure/SSLPage";
import { CertificatesPage } from "./pages/infrastructure/CertificatesPage";
import { DomainsPage } from "./pages/infrastructure/DomainsPage";
import { ControlCenter } from "./pages/agents/ControlCenter";
import { AgentRegistry } from "./pages/agents/AgentRegistry";
import { ModelRouter } from "./pages/agents/ModelRouter";
import { ModelRegistry } from "./pages/agents/ModelRegistry";
import { ModelBenchmarks } from "./pages/agents/ModelBenchmarks";
import { Instructions } from "./pages/agents/Instructions";
import { QualityControl } from "./pages/agents/QualityControl";
import { Evidence } from "./pages/agents/Evidence";
import { ReportsPage } from "./pages/reports/ReportsPage";
import { ClientReportsPage } from "./pages/reports/ClientReportsPage";
import { MonitoringPage } from "./pages/monitoring/MonitoringPage";
import { ChangesPage } from "./pages/monitoring/ChangesPage";
import { AlertsPage } from "./pages/monitoring/AlertsPage";
import { SettingsWorkspace } from "./pages/settings/SettingsWorkspace";
import { SettingsTeam } from "./pages/settings/SettingsTeam";
import { SettingsSecurity } from "./pages/settings/SettingsSecurity";
import { SettingsAPI } from "./pages/settings/SettingsAPI";
import { SettingsIntegrations } from "./pages/settings/SettingsIntegrations";
import { PlaceholderPage } from "./pages/PlaceholderPage";

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
