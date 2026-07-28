import { getSyncRuns, getSyncSummary } from "@/lib/queries";
import { StatTile } from "@/components/StatTile";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sincronizaciones — Portabilidad" };

const FMT = new Intl.DateTimeFormat("es-MX", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Duracion legible entre inicio y fin; '—' si la corrida sigue viva. */
function duracion(inicio: Date, fin: Date | null) {
  if (!fin) return "—";
  const s = Math.max(0, Math.round((fin.getTime() - inicio.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function EstadoPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; label: string }> = {
    ok: { bg: "var(--good)", label: "OK" },
    error: { bg: "var(--critical)", label: "Error" },
    running: { bg: "var(--warning)", label: "Corriendo" },
  };
  const s = map[status] ?? { bg: "var(--text-muted)", label: status };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        fontWeight: 600,
        color: s.bg,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: s.bg }} />
      {s.label}
    </span>
  );
}

export default async function SincronizacionesPage() {
  const [runs, resumen] = await Promise.all([getSyncRuns(100), getSyncSummary()]);

  return (
    <>
      <div className="page-head">
        <h1 style={{ fontSize: 22 }}>Sincronizaciones</h1>
        <p className="secondary" style={{ marginTop: 4, fontSize: 13.5 }}>
          Corridas de ingesta registradas por el proceso de sincronización: qué se
          leyó, qué cambió y si terminaron bien.
        </p>
      </div>

      <section
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}
      >
        <StatTile label="Corridas" value={resumen.total} hint="registradas" />
        <StatTile label="Exitosas" value={resumen.ok} accent="var(--good)" />
        <StatTile label="Con error" value={resumen.error} accent="var(--critical)" />
        <StatTile label="En curso" value={resumen.corriendo} accent="var(--warning)" />
      </section>

      {resumen.ultima ? (
        <section className="card">
          <h3 style={{ fontSize: 15 }}>Última corrida</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 16,
              marginTop: 14,
            }}
          >
            {[
              ["Origen", resumen.ultima.source.toUpperCase()],
              ["Etiqueta", resumen.ultima.runLabel || "—"],
              ["Inicio", FMT.format(resumen.ultima.startedAt)],
              ["Duración", duracion(resumen.ultima.startedAt, resumen.ultima.finishedAt)],
              ["Registros vistos", resumen.ultima.totalSeen.toLocaleString("es-MX")],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                  {k}
                </div>
                <div style={{ fontSize: 14, marginTop: 3 }}>{v}</div>
              </div>
            ))}
            <div>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                Estado
              </div>
              <div style={{ marginTop: 5 }}>
                <EstadoPill status={resumen.ultima.status} />
              </div>
            </div>
          </div>
          {resumen.ultima.errorMsg ? (
            <p
              style={{
                marginTop: 14,
                fontSize: 13,
                color: "var(--critical)",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "10px 12px",
              }}
            >
              {resumen.ultima.errorMsg}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h3 style={{ fontSize: 15 }}>Historial de corridas</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {runs.length} más reciente(s)
          </span>
        </div>
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Inicio</th>
                <th>Origen</th>
                <th>Etiqueta</th>
                <th>Estado</th>
                <th className="num">Duración</th>
                <th className="num">Vistos</th>
                <th className="num">Nuevos</th>
                <th className="num">Actualizados</th>
                <th className="num">Bajas</th>
                <th className="num">Cambios op.</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={String(r.id)}>
                  <td style={{ whiteSpace: "nowrap" }}>{FMT.format(r.startedAt)}</td>
                  <td className="secondary">{r.source.toUpperCase()}</td>
                  <td className="secondary">{r.runLabel || "—"}</td>
                  <td>
                    <EstadoPill status={r.status} />
                  </td>
                  <td className="num muted">{duracion(r.startedAt, r.finishedAt)}</td>
                  <td className="num">{r.totalSeen.toLocaleString("es-MX")}</td>
                  <td className="num">{r.inserted.toLocaleString("es-MX")}</td>
                  <td className="num">{r.updated.toLocaleString("es-MX")}</td>
                  <td className="num">{r.deleted.toLocaleString("es-MX")}</td>
                  <td className="num">{r.opChanges.toLocaleString("es-MX")}</td>
                </tr>
              ))}
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={10} className="muted">
                    Todavía no hay corridas registradas.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
