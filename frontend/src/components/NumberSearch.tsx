"use client";

import { useState } from "react";

type EventRow = {
  eventType: string;
  operatorFrom: string | null;
  operatorTo: string | null;
  source: string;
  runLabel: string | null;
  occurredAt: string;
};
type Result = {
  number: string;
  operator: string;
  state: string | null;
  nir: string | null;
  municipality: string | null;
  modalidad: string | null;
  status: string;
  changeCount: number;
  firstSeenAt: string;
  lastChangeAt: string;
  events: EventRow[];
} | null;

const EVENT_LABEL: Record<string, { text: string; color: string }> = {
  PORTED: { text: "Alta / portación", color: "var(--good)" },
  DELETED: { text: "Baja", color: "var(--critical)" },
  OPERATOR_CHANGE: { text: "Cambio de operador", color: "var(--warning)" },
};

export function NumberSearch() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [notFound, setNotFound] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const num = q.trim();
    if (!/^\d{10}$/.test(num)) {
      setNotFound(false);
      setResult(null);
      alert("Ingresa un número de 10 dígitos.");
      return;
    }
    setLoading(true);
    setNotFound(false);
    try {
      const res = await fetch(`/api/number/${num}`);
      if (res.status === 404) {
        setResult(null);
        setNotFound(true);
      } else {
        setResult(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h3 style={{ fontSize: 15 }}>Buscar historial de un número</h3>
      <form onSubmit={search} style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ej. 5512345678"
          inputMode="numeric"
          maxLength={10}
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--page)",
            color: "var(--text-primary)",
            fontSize: 15,
            fontVariantNumeric: "tabular-nums",
          }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "10px 18px",
            borderRadius: 8,
            border: "none",
            background: "var(--c1)",
            color: "#fff",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {loading ? "Buscando…" : "Buscar"}
        </button>
      </form>

      {notFound ? (
        <p className="muted" style={{ fontSize: 14, marginTop: 14 }}>
          No hay registro de ese número en la base de tracking.
        </p>
      ) : null}

      {result ? (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20, fontSize: 14 }}>
            <Field label="Número" value={result.number} mono />
            <Field label="Operador actual" value={result.operator} mono />
            <Field label="Estado" value={result.state ?? "—"} />
            <Field label="NIR" value={result.nir ?? "—"} mono />
            <Field label="Modalidad" value={result.modalidad ?? "—"} />
            <Field
              label="Estatus"
              value={result.status === "active" ? "Activo" : "Dado de baja"}
            />
            <Field label="Veces que ha cambiado" value={String(result.changeCount)} />
          </div>

          <h4 style={{ fontSize: 13, marginTop: 20, color: "var(--text-secondary)" }}>
            Línea de tiempo ({result.events.length} evento{result.events.length === 1 ? "" : "s"})
          </h4>
          <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
            {result.events.map((ev, i) => {
              const meta = EVENT_LABEL[ev.eventType] ?? { text: ev.eventType, color: "var(--c1)" };
              return (
                <li
                  key={i}
                  style={{
                    display: "flex",
                    gap: 12,
                    padding: "8px 0",
                    borderBottom: "1px solid var(--grid)",
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: meta.color,
                      marginTop: 5,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ fontSize: 14 }}>
                    <strong>{meta.text}</strong>
                    {ev.operatorFrom || ev.operatorTo ? (
                      <span className="secondary">
                        {" "}
                        {ev.operatorFrom ? `${ev.operatorFrom} → ` : ""}
                        {ev.operatorTo ?? ""}
                      </span>
                    ) : null}
                    <br />
                    <span className="muted" style={{ fontSize: 12 }}>
                      {new Date(ev.occurredAt).toLocaleString("es-MX")} · {ev.source}
                      {ev.runLabel ? ` · ${ev.runLabel}` : ""}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span className="muted" style={{ fontSize: 11, textTransform: "uppercase" }}>
        {label}
      </span>
      <span style={{ fontVariantNumeric: mono ? "tabular-nums" : "normal", fontWeight: 500 }}>
        {value}
      </span>
    </div>
  );
}
