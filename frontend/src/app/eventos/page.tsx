import Link from "next/link";
import { getEvents, getEventTypeCounts } from "@/lib/queries";
import { StatTile } from "@/components/StatTile";

export const dynamic = "force-dynamic";

export const metadata = { title: "Historial de eventos — Portabilidad" };

const PER_PAGE = 50;

const FMT = new Intl.DateTimeFormat("es-MX", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const TIPO: Record<string, { label: string; color: string }> = {
  PORTED: { label: "Alta", color: "var(--good)" },
  DELETED: { label: "Baja", color: "var(--critical)" },
  OPERATOR_CHANGE: { label: "Cambio de operador", color: "var(--c1)" },
};

function TipoPill({ t }: { t: string }) {
  const d = TIPO[t] ?? { label: t, color: "var(--text-muted)" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: d.color }} />
      {d.label}
    </span>
  );
}

export default async function EventosPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; tipo?: string }>;
}) {
  const sp = await searchParams;
  const tipo = sp.tipo && TIPO[sp.tipo] ? sp.tipo : undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  const [{ rows, total }, counts] = await Promise.all([
    getEvents({ page, perPage: PER_PAGE, eventType: tipo }),
    getEventTypeCounts(),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const byType = Object.fromEntries(counts.map((c) => [c.eventType, c.count]));
  const qs = (p: number) =>
    `/eventos?page=${p}` + (tipo ? `&tipo=${encodeURIComponent(tipo)}` : "");

  return (
    <>
      <div className="page-head">
        <h1 style={{ fontSize: 22 }}>Historial de eventos</h1>
        <p className="secondary" style={{ marginTop: 4, fontSize: 13.5 }}>
          Cada alta, baja y cambio de operador registrado, del más reciente al más
          antiguo.
        </p>
      </div>

      <section
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}
      >
        <StatTile label="Eventos totales" value={counts.reduce((s, c) => s + c.count, 0)} />
        <StatTile label="Altas" value={byType.PORTED ?? 0} accent="var(--good)" />
        <StatTile label="Bajas" value={byType.DELETED ?? 0} accent="var(--critical)" />
        <StatTile label="Cambios de operador" value={byType.OPERATOR_CHANGE ?? 0} accent="var(--c1)" />
      </section>

      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
          <h3 style={{ fontSize: 15 }}>
            {tipo ? TIPO[tipo].label : "Todos los eventos"}{" "}
            <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
              ({total.toLocaleString("es-MX")})
            </span>
          </h3>
          {/* Filtros por tipo: enlaces, sin estado de cliente. */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[["", "Todos"], ...Object.entries(TIPO).map(([k, v]) => [k, v.label])].map(
              ([k, label]) => {
                const activo = (k || undefined) === tipo;
                return (
                  <Link
                    key={k || "todos"}
                    href={k ? `/eventos?tipo=${k}` : "/eventos"}
                    style={{
                      fontSize: 12,
                      padding: "4px 10px",
                      borderRadius: 999,
                      textDecoration: "none",
                      border: "1px solid " + (activo ? "transparent" : "var(--border)"),
                      background: activo ? "var(--sidebar-active)" : "transparent",
                      color: activo ? "#fff" : "var(--text-secondary)",
                      fontWeight: activo ? 600 : 400,
                    }}
                  >
                    {label}
                  </Link>
                );
              }
            )}
          </div>
        </div>

        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Número</th>
                <th>Evento</th>
                <th>De</th>
                <th>A</th>
                <th>Origen</th>
                <th>Corrida</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={String(e.id)}>
                  <td style={{ whiteSpace: "nowrap" }} className="secondary">
                    {FMT.format(e.occurredAt)}
                  </td>
                  <td style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{e.number}</td>
                  <td>
                    <TipoPill t={e.eventType} />
                  </td>
                  <td className="secondary">{e.operatorFrom || "—"}</td>
                  <td className="secondary">{e.operatorTo || "—"}</td>
                  <td className="muted">{e.source}</td>
                  <td className="muted">{e.runLabel || "—"}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    No hay eventos para este filtro.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* Paginacion: enlaces simples, compatible con render en servidor. */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 14,
            gap: 12,
          }}
        >
          <span className="muted" style={{ fontSize: 12.5 }}>
            Página {page.toLocaleString("es-MX")} de {totalPages.toLocaleString("es-MX")}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            {page > 1 ? (
              <Link href={qs(page - 1)} className="pager">
                ← Anterior
              </Link>
            ) : (
              <span className="pager disabled">← Anterior</span>
            )}
            {page < totalPages ? (
              <Link href={qs(page + 1)} className="pager">
                Siguiente →
              </Link>
            ) : (
              <span className="pager disabled">Siguiente →</span>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
