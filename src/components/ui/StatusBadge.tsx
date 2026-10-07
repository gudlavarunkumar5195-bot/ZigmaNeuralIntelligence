interface StatusBadgeProps {
  status: string;
  size?: "sm" | "md";
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; dot?: string }> = {
  complete: { label: "Complete", color: "#10b981", bg: "#ecfdf5", dot: "#10b981" },
  completed: { label: "Completed", color: "#10b981", bg: "#ecfdf5", dot: "#10b981" },
  running: { label: "Running", color: "#3b82f6", bg: "#eff6ff", dot: "#3b82f6" },
  scanning: { label: "Scanning", color: "#3b82f6", bg: "#eff6ff", dot: "#3b82f6" },
  waiting: { label: "Waiting", color: "#94a3b8", bg: "#f1f5f9", dot: "#94a3b8" },
  failed: { label: "Failed", color: "#ef4444", bg: "#fef2f2", dot: "#ef4444" },
  rejected: { label: "Rejected", color: "#ef4444", bg: "#fef2f2" },
  improve: { label: "Improve", color: "#f59e0b", bg: "#fffbeb" },
  accepted: { label: "Accepted", color: "#10b981", bg: "#ecfdf5" },
  online: { label: "Online", color: "#10b981", bg: "#ecfdf5", dot: "#10b981" },
  critical: { label: "Critical", color: "#ef4444", bg: "#fef2f2" },
  high: { label: "High", color: "#f97316", bg: "#fff7ed" },
  medium: { label: "Medium", color: "#f59e0b", bg: "#fffbeb" },
  low: { label: "Low", color: "#6366f1", bg: "#eef2ff" },
  info: { label: "Info", color: "#3b82f6", bg: "#eff6ff" },
  "human-review": { label: "Human Review", color: "#8b5cf6", bg: "#f5f3ff" },
  enabled: { label: "Enabled", color: "#10b981", bg: "#ecfdf5" },
  disabled: { label: "Disabled", color: "#94a3b8", bg: "#f1f5f9" },
  "integration-required": { label: "Integration Required", color: "#f59e0b", bg: "#fffbeb" },
  verified: { label: "Verified", color: "#10b981", bg: "#ecfdf5" },
  pending: { label: "Pending", color: "#94a3b8", bg: "#f1f5f9" },
};

export function StatusBadge({ status, size = "sm" }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status.toLowerCase()] || { label: status, color: "#64748b", bg: "#f1f5f9" };
  const padClass = size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-xs";

  return (
    <span role="status" aria-label={`Status: ${config.label}`}
      className={`inline-flex items-center gap-1.5 rounded font-500 ${padClass}`}
      style={{ color: config.color, background: config.bg }}
    >
      {config.dot && (
        <span
          className="flex-shrink-0 rounded-full"
          style={{
            width: 6,
            height: 6,
            background: config.dot,
            animation: status === "running" || status === "scanning" ? "pulse-dot 1.5s ease-in-out infinite" : "none",
          }}
        />
      )}
      {config.label}
    </span>
  );
}

interface SeverityBadgeProps {
  severity: string;
}

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  return <StatusBadge status={severity} />;
}
