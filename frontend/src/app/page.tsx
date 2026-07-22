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
    <main className="container">
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 26 }}>Portabilidad numérica — México</h1>
        <p className="secondary" style={{ marginTop: 6, fontSize: 15 }}>
          Comportamiento de la portabilidad: cantidad de números, distribución por
          estado y operador, e historial de cambios.
        </p>
      </header>

      {/* KPIs */}
      <section
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
      >
        <StatTile label="Números activos" value={kpis.activos} hint="portados vigentes" />
        <StatTile
          label="Dados de baja"
          value={kpis.dadosDeBaja}
          hint="históricos"
          accent="var(--critical)"
        />
        <StatTile
          label="Cambios de operador"
          value={kpis.cambiosOperador}
          hint="re-portaciones"
          accent="var(--warning)"
        />
        <StatTile label="Eventos registrados" value={kpis.totalEventos} hint="altas + bajas + cambios" />
        <StatTile label="Sincronizaciones" value={kpis.corridas} hint="corridas OK" />
      </section>

      {/* Mapa + tabla por estado */}
      <section
        className="grid"
        style={{ gridTemplateColumns: "1.4fr 1fr", marginTop: 16, alignItems: "start" }}
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
        style={{ gridTemplateColumns: "1fr 1fr", marginTop: 16, alignItems: "start" }}
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
      <section style={{ marginTop: 16 }}>
        <Heatmap
          operators={matrix.operators}
          states={matrix.states}
          matrix={matrix.matrix}
        />
      </section>

      {/* Buscador de historial */}
      <section style={{ marginTop: 16 }}>
        <NumberSearch />
      </section>

      {/* Ranking de más cambiados */}
      <section className="card" style={{ marginTop: 16 }}>
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

      <footer className="muted" style={{ marginTop: 32, fontSize: 12 }}>
        Estado geográfico derivado del NIR según el catálogo del IFT.
      </footer>
    </main>
  );
}
