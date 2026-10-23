import { useParams } from "react-router";
import { PageContainer, PageHeader } from "../../components/ui/Card";
import { Notice, RouteTabs } from "../../components/ui/Primitives";
import { IntegrationRequiredState, LoadingState } from "../../components/ui/DataState";
import { IS_DEMO } from "../../config/env";
import { useAccess } from "./model-intelligence/shared";
import { OverviewTab } from "./model-intelligence/OverviewTab";
import { ModelsTab } from "./model-intelligence/ModelsTab";
import { TasksTab } from "./model-intelligence/TasksTab";
import { UsageTab } from "./model-intelligence/UsageTab";
import { QualityTab } from "./model-intelligence/QualityTab";
import { SecurityTab } from "./model-intelligence/SecurityTab";
import { SettingsTab } from "./model-intelligence/SettingsTab";
import { FeasibilityTab } from "./model-intelligence/FeasibilityTab";

const BASE = "/agents/model-intelligence";

/** `admin`: the API requires an organization owner or admin; members see the rest. */
export const MODEL_INTELLIGENCE_TABS = [
  { id: "overview", label: "Overview", admin: false },
  { id: "models", label: "Models", admin: true },
  { id: "tasks", label: "Routing & tasks", admin: true },
  { id: "usage", label: "Usage", admin: true },
  { id: "quality", label: "Quality", admin: true },
  { id: "security", label: "Security", admin: true },
  { id: "settings", label: "Settings", admin: true },
  { id: "feasibility", label: "Feasibility check", admin: false },
] as const;
type TabId = (typeof MODEL_INTELLIGENCE_TABS)[number]["id"];

export function ModelIntelligence() {
  const { tab: rawTab } = useParams();
  const access = useAccess();
  const tabs = MODEL_INTELLIGENCE_TABS.filter((t) => !t.admin || access.isOrgAdmin);
  const requested = MODEL_INTELLIGENCE_TABS.find((t) => t.id === rawTab);
  const tab: TabId = (tabs.find((t) => t.id === rawTab)?.id ?? "overview") as TabId;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="AI Agents"
        title="Model Intelligence"
        subtitle="How the autonomous router picks free models, what it has spent, how well each model performs, and what it blocked."
      />
      {IS_DEMO ? (
        <IntegrationRequiredState feature="Model Intelligence" />
      ) : access.loading ? (
        <LoadingState label="Checking your access…" />
      ) : (
        <>
          <RouteTabs label="Model Intelligence sections" current={tab} tabs={tabs.map((t) => ({ id: t.id, label: t.label, to: t.id === "overview" ? BASE : `${BASE}/${t.id}` }))} />
          <div className="mt-4">
            {requested && requested.admin && !access.isOrgAdmin ? (
              <div className="mb-4"><Notice tone="info">{requested.label} is available to organization owners and admins. You can still see the router overview and run a feasibility check.</Notice></div>
            ) : null}
            {tab === "overview" && <OverviewTab access={access} />}
            {tab === "models" && <ModelsTab />}
            {tab === "tasks" && <TasksTab />}
            {tab === "usage" && <UsageTab />}
            {tab === "quality" && <QualityTab />}
            {tab === "security" && <SecurityTab />}
            {tab === "settings" && <SettingsTab access={access} />}
            {tab === "feasibility" && <FeasibilityTab />}
          </div>
        </>
      )}
    </PageContainer>
  );
}
