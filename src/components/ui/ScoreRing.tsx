interface ScoreRingProps {
  score: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
  showLabel?: boolean;
  className?: string;
}

function scoreColor(score: number): string {
  if (score >= 95) return "#10b981";
  if (score >= 90) return "#10b981";
  if (score >= 80) return "#3b82f6";
  if (score >= 70) return "#f59e0b";
  return "#ef4444";
}

function scoreLabel(score: number): string {
  if (score >= 95) return "Excellent";
  if (score >= 90) return "Good";
  if (score >= 80) return "Fair";
  if (score >= 70) return "Poor";
  return "Critical";
}

export function ScoreRing({ score, size = 64, strokeWidth = 5, label, showLabel = false, className = "" }: ScoreRingProps) {
  const r = (size - strokeWidth * 2) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (score / 100) * circumference;
  const color = scoreColor(score);

  return (
    <div className={`flex flex-col items-center gap-1 ${className}`}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="#e2e8f0"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ transition: "stroke-dashoffset 0.6s ease" }}
          />
        </svg>
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          <span className="font-500 leading-none" style={{ fontSize: size * 0.22, color }}>
            {score}
          </span>
        </div>
      </div>
      {showLabel && (
        <span className="text-xs font-500" style={{ color }}>
          {label || scoreLabel(score)}
        </span>
      )}
    </div>
  );
}

interface SmallScoreProps {
  score: number;
  label: string;
  size?: number;
}

export function SmallScore({ score, label, size = 44 }: SmallScoreProps) {
  const r = (size - 4) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (score / 100) * circumference;
  const color = scoreColor(score);

  return (
    <div className="flex items-center gap-2.5">
      <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e2e8f0" strokeWidth={3.5} />
          <circle
            cx={cx} cy={cy} r={r} fill="none" stroke={color}
            strokeWidth={3.5}
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-700 leading-none" style={{ fontSize: size * 0.25, color, fontFamily: "'JetBrains Mono', monospace" }}>
            {score}
          </span>
        </div>
      </div>
      <span className="text-sm font-500 text-slate-600">{label}</span>
    </div>
  );
}
