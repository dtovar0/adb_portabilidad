export function StatTile({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number | string;
  hint?: string;
  accent?: string;
}) {
  const v = typeof value === "number" ? value.toLocaleString("es-MX") : value;
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="secondary" style={{ fontSize: 13, fontWeight: 600 }}>
        {label}
      </span>
      <span
        style={{
          fontSize: 32,
          fontWeight: 700,
          lineHeight: 1.1,
          color: accent ?? "var(--text-primary)",
        }}
      >
        {v}
      </span>
      {hint ? (
        <span className="muted" style={{ fontSize: 12 }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
