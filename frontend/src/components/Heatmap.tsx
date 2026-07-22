"use client";

import { useState } from "react";

// Matriz operador x estado. Sequential blue (magnitud): celda mas clara = cerca
// de cero. Hover por celda -> tooltip. Etiquetas de filas/columnas directas.

const RAMP = ["--seq-100", "--seq-250", "--seq-400", "--seq-550", "--seq-700"];

function bucket(v: number, max: number) {
  if (v <= 0 || max <= 0) return -1;
  const t = v / max;
  if (t <= 0.05) return 0;
  if (t <= 0.2) return 1;
  if (t <= 0.45) return 2;
  if (t <= 0.75) return 3;
  return 4;
}

export function Heatmap({
  operators,
  states,
  matrix,
}: {
  operators: string[];
  states: string[];
  matrix: number[][];
}) {
  const [hover, setHover] = useState<{ op: string; st: string; v: number } | null>(null);
  const max = Math.max(1, ...matrix.flat());

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ fontSize: 15 }}>Cruce operador × estado</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {hover ? `${hover.op} · ${hover.st}: ${hover.v.toLocaleString("es-MX")}` : "números activos"}
        </span>
      </div>

      {operators.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
          Sin datos todavía.
        </p>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 14 }}>
          <table style={{ borderCollapse: "separate", borderSpacing: 2 }}>
            <thead>
              <tr>
                <th style={{ border: "none", background: "transparent" }} />
                {states.map((s) => (
                  <th
                    key={s}
                    style={{
                      border: "none",
                      background: "transparent",
                      fontSize: 10,
                      fontWeight: 600,
                      color: "var(--text-secondary)",
                      writingMode: "vertical-rl",
                      transform: "rotate(180deg)",
                      whiteSpace: "nowrap",
                      height: 90,
                      verticalAlign: "bottom",
                      padding: 0,
                    }}
                  >
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {operators.map((op, oi) => (
                <tr key={op}>
                  <td
                    style={{
                      border: "none",
                      background: "transparent",
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      whiteSpace: "nowrap",
                      paddingRight: 8,
                      textAlign: "right",
                      fontWeight: 500,
                    }}
                  >
                    {op}
                  </td>
                  {states.map((st, si) => {
                    const v = matrix[oi][si];
                    const b = bucket(v, max);
                    return (
                      <td
                        key={st}
                        onMouseEnter={() => setHover({ op, st, v })}
                        onMouseLeave={() => setHover(null)}
                        title={`${op} · ${st}: ${v.toLocaleString("es-MX")}`}
                        style={{
                          border: "none",
                          width: 26,
                          height: 26,
                          borderRadius: 4,
                          background: b < 0 ? "var(--grid)" : `var(${RAMP[b]})`,
                          cursor: "pointer",
                          padding: 0,
                        }}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
        <span className="muted" style={{ fontSize: 11 }}>
          menos
        </span>
        {RAMP.map((r) => (
          <span key={r} style={{ width: 22, height: 10, borderRadius: 2, background: `var(${r})` }} />
        ))}
        <span className="muted" style={{ fontSize: 11 }}>
          más
        </span>
      </div>
    </div>
  );
}
