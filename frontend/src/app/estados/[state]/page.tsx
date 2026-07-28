import Link from "next/link";
import { notFound } from "next/navigation";
import { getStateDetail } from "@/lib/queries";
import { StatTile } from "@/components/StatTile";
import { BarList, type BarItem } from "@/components/BarList";

export const dynamic = "force-dynamic";

const CAT = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8"];

export default async function EstadoDetallePage({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const { state: raw } = await params;
  const state = decodeURIComponent(raw);
  const d = await getStateDetail(state);

  // Sin numeros ni NIRs asociados: la entidad no existe en el catalogo.
  if (d.activos === 0 && d.bajas === 0 && d.nirs.length === 0) notFound();

  const operadorItems: BarItem[] = d.operadores.slice(0, 10).map((o, i) => ({
    label: o.operator,
    value: o.count,
    color: `var(${CAT[i % CAT.length]})`,
  }));
  const modalidadItems: BarItem[] = d.modalidades.map((m) => ({
    label: m.modalidad,
    value: m.count,
  }));

  return (
    <>
      <div className="page-head">
        <Link href="/estados" className="muted" style={{ fontSize: 13, textDecoration: "none" }}>
          ← Volver a estados
        </Link>
        <h1 style={{ fontSize: 22, marginTop: 8 }}>{state}</h1>
        <p className="secondary" style={{ marginTop: 4, fontSize: 13.5 }}>
          Portabilidad en la entidad, derivada de los NIR asignados por el IFT.
        </p>
      </div>

      <section
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}
      >
        <StatTile label="Números activos" value={d.activos} />
        <StatTile label="Dados de baja" value={d.bajas} hint="históricos" />
        <StatTile label="Operadores" value={d.operadores.length} hint="con presencia" />
        <StatTile label="NIR asignados" value={d.nirs.length} hint="catálogo IFT" />
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr 1fr", alignItems: "start" }}>
        <BarList items={operadorItems} title="Operadores en el estado" unit="números" />
        <BarList items={modalidadItems} title="Distribución por modalidad" unit="números" />
      </section>

      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h3 style={{ fontSize: 15 }}>NIR de la entidad</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {d.nirs.length} rango(s)
          </span>
        </div>
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>NIR</th>
                <th>Población principal</th>
              </tr>
            </thead>
            <tbody>
              {d.nirs.map((n) => (
                <tr key={n.nir}>
                  <td style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{n.nir}</td>
                  <td className="secondary">{n.population || "—"}</td>
                </tr>
              ))}
              {d.nirs.length === 0 ? (
                <tr>
                  <td colSpan={2} className="muted">
                    Sin NIR en el catálogo para esta entidad.
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
