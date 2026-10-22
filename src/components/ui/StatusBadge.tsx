import { pill, type Tone } from "./styles";

interface StatusBadgeProps {
  status: string;
  size?: "sm" | "md";
}

const STATUS_CONFIG: Record<string, { label: string; tone: Tone; live?: boolean }> = {
  complete: { label: "Complete", tone: "success" },
  completed: { label: "Completed", tone: "success" },
  running: { label: "Running", tone: "accent", live: true },
  scanning: { label: "Scanning", tone: "accent", live: true },
  waiting: { label: "Waiting", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  rejected: { label: "Rejected", tone: "danger" },
  improve: { label: "Improve", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  online: { label: "Online", tone: "success" },
  critical: { label: "Critical", tone: "danger" },
  high: { label: "High", tone: "danger" },
  medium: { label: "Medium", tone: "warning" },
  low: { label: "Low", tone: "info" },
  info: { label: "Info", tone: "neutral" },
  "human-review": { label: "Human Review", tone: "accent" },
  enabled: { label: "Enabled", tone: "success" },
  disabled: { label: "Disabled", tone: "neutral" },
  "integration-required": { label: "Integration Required", tone: "warning" },
  verified: { label: "Verified", tone: "success" },
  pending: { label: "Pending", tone: "neutral" },
};

/** Status as a labelled pill; the text carries the meaning, the tone reinforces it. */
export function StatusBadge({ status, size = "sm" }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status.toLowerCase()] ?? { label: status, tone: "neutral" as Tone };
  return (
    <span role="status" aria-label={`Status: ${config.label}`} className={`${pill(config.tone)} ${size === "md" ? "px-2 py-1 text-xs" : ""}`}>
      {config.live ? <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
      {config.label}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <StatusBadge status={severity} />;
}
