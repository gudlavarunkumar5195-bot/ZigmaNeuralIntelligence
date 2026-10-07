import { SettingsLayout, SettingsUnavailable } from "./SettingsLayout";

export function SettingsIntegrations() {
  return (
    <SettingsLayout eyebrow="Integrations" title="Integrations">
      <SettingsUnavailable
        title="Connected integrations"
        description="Integration status is not available yet because the backend does not expose an integrations endpoint. Provider credentials stay server-side."
      />
    </SettingsLayout>
  );
}
