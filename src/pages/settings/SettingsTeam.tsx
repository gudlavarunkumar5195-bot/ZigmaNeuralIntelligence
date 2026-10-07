import { SettingsLayout, SettingsUnavailable } from "./SettingsLayout";

export function SettingsTeam() {
  return (
    <SettingsLayout eyebrow="Team" title="Team settings">
      <SettingsUnavailable
        title="Members and invitations"
        description="Member listing, role management and invitations are not available yet because the backend does not expose organization membership endpoints. No member data is shown."
      />
    </SettingsLayout>
  );
}
