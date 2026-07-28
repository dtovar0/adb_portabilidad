import Link from "next/link";
import { getStateIndex, getByState } from "@/lib/queries";
import { StatTile } from "@/components/StatTile";
import { Choropleth } from "@/components/Choropleth";
import geo from "@/data/mexico_estados.json";

export const dynamic = "force-dynamic";

const GEO_TO_DATA: Record<string, string> = { México: "Estado de México" };

export const metadata = { title: "Por estado — Portabilidad" };

export default async function EstadosPage() {
  const [estados, byState] = await Promise.all([getStateIndex(), getByState()]);

  const stateCounts: Record<string, number> = {};
  for (const r of byState) stateCounts[r.state] = r.count;

  const totalActivos = estados.reduce((s, e) => s + e.activos, 0);
  const conCobertura = estados.filter((e) => e.activos > 0).length;

  return (
    <>
      <div className="page-head">
        <h1 style={{ fontSize: 22 }}>Por estado</h1>
        <p className="secondary" style={{ marginTop: 4, fontSize: 13.5 }}>
          Distribución geográfica de los números portados. El estado se deriva del
          NIR según el catálogo del IFT.
        </p>
      </div>

      <section
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}
      >
        <StatTile label="Números activos" value={totalActivos} hint="en todo el país" />
        <StatTile label="Entidades con datos" value={conCobertura} hint={`de ${estados.length}`} />
        <StatTile
          label="Estado con más"
          value={estados[0]?.activos ?? 0}
          hint={estados[0]?.state ?? "—"}
        />
      </section>

      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h3 style={{ fontSize: 15 }}>Números activos por estado</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            pasa el cursor por un estado
          </span>
        </div>
        <div style={{ marginTop: 12 }}>
          <Choropleth
            geo={geo as any}
            counts={stateCounts}
            nameKey="name"
            nameMap={GEO_TO_DATA}
          />
        </div>
      </section>

      <section className="card">
        <h3 style={{ fontSize: 15 }}>Detalle por entidad</h3>
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Estado</th>
                <th className="num">Activos</th>
                <th className="num">Participación</th>
                <th className="num">Dados de baja</th>
                <th>Operador dominante</th>
                <th className="num">Operadores</th>
              </tr>
            </thead>
            <tbody>
              {estados.map((e) => {
                const share = totalActivos ? (e.activos / totalActivos) * 100 : 0;
                return (
                  <tr key={e.state}>
                    <td>
                      <Link
                        href={`/estados/${encodeURIComponent(e.state)}`}
                        style={{ textDecoration: "none", fontWeight: 500 }}
                      >
                        {e.state}
                      </Link>
                    </td>
                    <td className="num">{e.activos.toLocaleString("es-MX")}</td>
                    <td className="num muted">{share.toFixed(1)}%</td>
                    <td className="num">{e.bajas.toLocaleString("es-MX")}</td>
                    <td className="secondary">
                      {e.topOperador}
                      {e.topOperadorCount > 0 ? (
                        <span className="muted">
                          {" "}
                          ({e.topOperadorCount.toLocaleString("es-MX")})
                        </span>
                      ) : null}
                    </td>
                    <td className="num">{e.operadores}</td>
                  </tr>
                );
              })}
              {estados.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    Sin datos todavía. Corre una sincronización.
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
