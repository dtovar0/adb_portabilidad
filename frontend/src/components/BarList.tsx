// Lista de barras horizontales ordenadas (magnitud por categoria).
// Marca fina, extremo redondeado 4px anclado a la izquierda, etiqueta directa.
// Una sola serie -> sin leyenda (el titulo la nombra). Color: azul secuencial
// por defecto; los operadores usan colores categoricos pasados por prop.
export type BarItem = { label: string; value: number; color?: string };

export function BarList({
  items,
  title,
  total,
  unit = "números",
}: {
  items: BarItem[];
  title: string;
  total?: number;
  unit?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const sum = total ?? items.reduce((s, i) => s + i.value, 0);
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ fontSize: 15 }}>{title}</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {sum.toLocaleString("es-MX")} {unit}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
        {items.map((i) => {
          const pct = (i.value / max) * 100;
          const share = sum ? ((i.value / sum) * 100).toFixed(1) : "0";
          return (
            <div key={i.label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 13,
                }}
              >
                <span className="secondary" style={{ fontWeight: 500 }}>
                  {i.label}
                </span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {i.value.toLocaleString("es-MX")}{" "}
                  <span className="muted">({share}%)</span>
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  background: "var(--grid)",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <div
                  title={`${i.label}: ${i.value.toLocaleString("es-MX")}`}
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: i.color ?? "var(--seq-400)",
                    borderRadius: 4,
                  }}
                />
              </div>
            </div>
          );
        })}
        {items.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            Sin datos todavía. Corre una sincronización.
          </span>
        ) : null}
      </div>
    </div>
  );
}
