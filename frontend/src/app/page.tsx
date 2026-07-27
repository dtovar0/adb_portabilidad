import Link from "next/link";
import {
  getKpis,
  getByState,
  getByOperator,
  getByModalidad,
  getMostChanged,
  getOperatorStateMatrix,
} from "@/lib/queries";
import { StatTile } from "@/components/StatTile";
import { BarList, type BarItem } from "@/components/BarList";
import { Choropleth } from "@/components/Choropleth";
import { Heatmap } from "@/components/Heatmap";
import { NumberSearch } from "@/components/NumberSearch";
import geo from "@/data/mexico_estados.json";

// Datos siempre frescos (no cachear entre corridas de sincronizacion).
export const dynamic = "force-dynamic";

// Colores categoricos en ORDEN FIJO (paleta dataviz), nunca ciclados.
const CAT = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8"];

// El GeoJSON usa "México" para lo que en los datos es "Estado de México".
const GEO_TO_DATA: Record<string, string> = { México: "Estado de México" };

// Iconos de los KPIs (stroke, heredan color del contenedor).
const ico = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);
const ICONS = {
  phone: ico(<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.4 2.1L8 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z" />),
  trash: ico(<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />),
  swap: ico(<><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>),
  doc: ico(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h4" /></>),
  sync: ico(<><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></>),
};

// Sparklines de tendencia (ilustrativos, deterministas: sin datos históricos
// reales todavía). Se reemplazarán por series de eventos por día cuando existan.
const SPARK = {
  activos: [42, 45, 44, 48, 52, 51, 55, 58, 60, 63, 67, 71],
  bajas: [12, 14, 13, 15, 14, 16, 15, 14, 13, 14, 13, 12],
  cambios: [22, 26, 24, 30, 28, 33, 31, 36, 34, 38, 41, 44],
  eventos: [55, 60, 58, 64, 68, 66, 72, 78, 80, 85, 88, 92],
  corridas: [4, 5, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12],
};

export default async function Page() {
  const [kpis, byState, byOperator, byModalidad, mostChanged, matrix] = await Promise.all([
    getKpis(),
    getByState(),
    getByOperator(8),
    getByModalidad(),
    getMostChanged(15),
    getOperatorStateMatrix(8, 12),
  ]);

  // counts por nombre_de_dato para el mapa.
  const stateCounts: Record<string, number> = {};
  for (const r of byState) stateCounts[r.state] = r.count;

  const operatorItems: BarItem[] = byOperator.map((o, i) => ({
    label: o.operator,
    value: o.count,
    color: `var(${CAT[i % CAT.length]})`,
  }));

  const modalidadItems: BarItem[] = byModalidad.map((m) => ({
    label:
      m.modalidad === "FIJO"
        ? "Fijo"
        : m.modalidad === "CPP"
          ? "Móvil (CPP)"
          : m.modalidad === "MPP"
            ? "Móvil (MPP)"
            : m.modalidad,
    value: m.count,
  }));

  const stateItems: BarItem[] = byState.slice(0, 12).map((s) => ({
    label: s.state,
    value: s.count,
  }));

  return (
    <>
      <div className="page-head" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 22 }}>Panel general</h1>
          <p className="secondary" style={{ marginTop: 4, fontSize: 13.5 }}>
            Comportamiento de la portabilidad: cantidad de números, distribución por
            estado y operador, e historial de cambios.
          </p>
        </div>
      </div>

      {/* KPIs */}
      <section
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}
      >
        <StatTile
          label="Números activos"
          value={kpis.activos}
          hint="portados vigentes"
          icon={ICONS.phone}
          accent="var(--c1)"
          delta="+3.2%"
          deltaDir="up"
          spark={SPARK.activos}
          sparkColor="var(--c1)"
        />
        <StatTile
          label="Dados de baja"
          value={kpis.dadosDeBaja}
          hint="históricos"
          icon={ICONS.trash}
          accent="var(--critical)"
          delta="-1.1%"
          deltaDir="down"
          spark={SPARK.bajas}
          sparkColor="var(--critical)"
        />
        <StatTile
          label="Cambios de operador"
          value={kpis.cambiosOperador}
          hint="re-portaciones"
          icon={ICONS.swap}
          accent="var(--warning)"
          delta="+5.7%"
          deltaDir="warn"
          spark={SPARK.cambios}
          sparkColor="var(--warning)"
        />
        <StatTile
          label="Eventos registrados"
          value={kpis.totalEventos}
          hint="altas + bajas + cambios"
          icon={ICONS.doc}
          accent="var(--c3)"
          spark={SPARK.eventos}
          sparkColor="var(--c3)"
        />
        <StatTile
          label="Sincronizaciones"
          value={kpis.corridas}
          hint="corridas OK"
          icon={ICONS.sync}
          accent="var(--c7)"
          spark={SPARK.corridas}
          sparkColor="var(--c7)"
        />
      </section>

      {/* Mapa + tabla por estado */}
      <section
        className="grid"
        style={{ gridTemplateColumns: "1.4fr 1fr", alignItems: "start" }}
      >
        <Choropleth
          geo={geo as any}
          counts={stateCounts}
          nameKey="name"
          nameMap={GEO_TO_DATA}
        />
        <BarList items={stateItems} title="Top estados" unit="números" />
      </section>

      {/* Operador + modalidad */}
      <section
        className="grid"
        style={{ gridTemplateColumns: "1fr 1fr", alignItems: "start" }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <BarList items={operatorItems} title="Distribución por operador" unit="números" />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {byOperator
              .filter((o) => o.operator !== "Otros")
              .map((o) => (
                <Link
                  key={o.operator}
                  href={`/operador/${encodeURIComponent(o.operator)}`}
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--border)",
                    textDecoration: "none",
                    color: "var(--text-secondary)",
                  }}
                >
                  {o.operator} →
                </Link>
              ))}
          </div>
        </div>
        <BarList items={modalidadItems} title="Distribución por modalidad" unit="números" />
      </section>

      {/* Cruce operador x estado */}
      <section>
        <Heatmap
          operators={matrix.operators}
          states={matrix.states}
          matrix={matrix.matrix}
        />
      </section>

      {/* Buscador de historial */}
      <section id="buscador" style={{ scrollMarginTop: 70 }}>
        <NumberSearch />
      </section>

      {/* Ranking de más cambiados */}
      <section className="card">
        <h3 style={{ fontSize: 15 }}>Números con más cambios</h3>
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Número</th>
                <th>Operador</th>
                <th>Estado</th>
                <th className="num">Cambios</th>
                <th>Estatus</th>
                <th>Último cambio</th>
              </tr>
            </thead>
            <tbody>
              {mostChanged.map((n) => (
                <tr key={n.number}>
                  <td className="num">{n.number}</td>
                  <td>{n.operator}</td>
                  <td>{n.state ?? "—"}</td>
                  <td className="num">{n.changeCount}</td>
                  <td>{n.status === "active" ? "Activo" : "Baja"}</td>
                  <td className="muted">{new Date(n.lastChangeAt).toLocaleDateString("es-MX")}</td>
                </tr>
              ))}
              {mostChanged.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    Sin datos. Corre <code>npm run sync -- --source abd</code> en el backend.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="muted" style={{ marginTop: 16, fontSize: 12 }}>
        Estado geográfico derivado del NIR según el catálogo del IFT. · Datos de demostración.
      </footer>
    </>
  );
}
