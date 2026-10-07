import { SettingsLayout, SettingsUnavailable } from "./SettingsLayout";

export function SettingsSecurity() {
  return (
    <SettingsLayout eyebrow="Security" title="Security settings">
      <SettingsUnavailable
        title="Security policy"
        description="MFA, audit-log retention and security posture reporting are not available yet. No policy status is shown because it cannot be verified from the backend."
      />
    </SettingsLayout>
  );
}
