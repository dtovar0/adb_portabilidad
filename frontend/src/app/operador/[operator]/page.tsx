import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getOperatorKpis,
  getOperatorByState,
  getOperators,
} from "@/lib/queries";
import { StatTile } from "@/components/StatTile";
import { BarList, type BarItem } from "@/components/BarList";
import { Choropleth } from "@/components/Choropleth";
import geo from "@/data/mexico_estados.json";

export const dynamic = "force-dynamic";

const GEO_TO_DATA: Record<string, string> = { México: "Estado de México" };

export default async function OperatorPage({
  params,
}: {
  params: Promise<{ operator: string }>;
}) {
  const { operator: raw } = await params;
  const operator = decodeURIComponent(raw);

  const [kpis, byState, operators] = await Promise.all([
    getOperatorKpis(operator),
    getOperatorByState(operator),
    getOperators(),
  ]);

  // Si el operador no tiene ningun numero ni evento, 404.
  if (kpis.activos === 0 && kpis.dadosDeBaja === 0 && kpis.ganados === 0) {
    notFound();
  }

  const stateCounts: Record<string, number> = {};
  for (const r of byState) stateCounts[r.state] = r.count;
  const stateItems: BarItem[] = byState.slice(0, 12).map((s) => ({
    label: s.state,
    value: s.count,
  }));

  return (
    <main className="container">
      <header style={{ marginBottom: 20 }}>
        <Link href="/" className="muted" style={{ fontSize: 13, textDecoration: "none" }}>
          ← Volver al dashboard
        </Link>
        <h1 style={{ fontSize: 24, marginTop: 8 }}>Operador {operator}</h1>
        <p className="secondary" style={{ marginTop: 6, fontSize: 15 }}>
          Comportamiento de la portabilidad para este operador.
        </p>
      </header>

      <section
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}
      >
        <StatTile label="Números activos" value={kpis.activos} />
        <StatTile
          label="Ganados"
          value={kpis.ganados}
          hint="altas + cambios hacia él"
          accent="var(--good)"
        />
        <StatTile
          label="Perdidos"
          value={kpis.perdidos}
          hint="cambios hacia otro operador"
          accent="var(--critical)"
        />
        <StatTile label="Dados de baja" value={kpis.dadosDeBaja} />
      </section>

      <section
        className="grid"
        style={{ gridTemplateColumns: "1.4fr 1fr", marginTop: 16, alignItems: "start" }}
      >
        <Choropleth geo={geo as any} counts={stateCounts} nameKey="name" nameMap={GEO_TO_DATA} />
        <BarList items={stateItems} title={`Top estados — ${operator}`} unit="números" />
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: 15 }}>Otros operadores</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          {operators
            .filter((o) => o.operator !== operator)
            .slice(0, 20)
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
                {o.operator} ({o.count.toLocaleString("es-MX")})
              </Link>
            ))}
        </div>
      </section>
    </main>
  );
}
