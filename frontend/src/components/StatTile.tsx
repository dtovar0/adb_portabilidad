// Tile de KPI. Soporta opcionalmente un icono, una variacion (delta) y una
// mini-serie (sparkline). Todo lo nuevo es opcional: los usos previos (label +
// value + hint + accent) siguen funcionando igual.

type DeltaDir = "up" | "down" | "warn";

function Sparkline({ points, color }: { points: number[]; color: string }) {
  const w = 74;
  const h = 30;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const norm = points.map((v, i) => [
    (i / (points.length - 1)) * w,
    h - ((v - min) / (max - min || 1)) * (h - 4) - 2,
  ]);
  const line = norm.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = line + ` L${w} ${h} L0 ${h} Z`;
  const gid = "spk-" + color.replace(/[^a-z0-9]/gi, "");
  const last = norm[norm.length - 1];
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ position: "absolute", right: 0, top: 4, width: 74, height: 30, opacity: 0.9 }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} />
      <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r={2.2} fill={color} />
    </svg>
  );
}

export function StatTile({
  label,
  value,
  hint,
  accent,
  icon,
  delta,
  deltaDir = "up",
  spark,
  sparkColor = "var(--c1)",
}: {
  label: string;
  value: number | string;
  hint?: string;
  accent?: string;
  icon?: React.ReactNode;
  /** texto de variación, p. ej. "+3.2%" */
  delta?: string;
  deltaDir?: DeltaDir;
  /** serie corta para la mini-gráfica */
  spark?: number[];
  sparkColor?: string;
}) {
  const v = typeof value === "number" ? value.toLocaleString("es-MX") : value;
  const deltaColor =
    deltaDir === "down" ? "var(--critical)" : deltaDir === "warn" ? "var(--warning)" : "var(--good)";

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 6, position: "relative" }}>
      {spark && spark.length > 1 ? <Sparkline points={spark} color={sparkColor} /> : null}

      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        {icon ? (
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: `color-mix(in srgb, ${accent ?? "var(--c1)"} 15%, transparent)`,
              color: accent ?? "var(--c1)",
            }}
          >
            {icon}
          </span>
        ) : null}
        <span className="secondary" style={{ fontSize: 12, fontWeight: 600 }}>
          {label}
        </span>
      </div>

      <span
        style={{
          fontSize: 28,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: "-0.01em",
          fontVariantNumeric: "tabular-nums",
          color: accent && !icon ? accent : "var(--text-primary)",
        }}
      >
        {v}
      </span>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        {hint ? (
          <span className="muted" style={{ fontSize: 11.5 }}>
            {hint}
          </span>
        ) : (
          <span />
        )}
        {delta ? (
          <span style={{ fontSize: 12, fontWeight: 600, color: deltaColor, fontVariantNumeric: "tabular-nums" }}>
            {delta}
          </span>
        ) : null}
      </div>
    </div>
  );
}
