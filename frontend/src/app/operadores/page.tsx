import Link from "next/link";
import { getOperatorIndex } from "@/lib/queries";
import { StatTile } from "@/components/StatTile";
import { BarList, type BarItem } from "@/components/BarList";

export const dynamic = "force-dynamic";

export const metadata = { title: "Por operador — Portabilidad" };

const CAT = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8"];

export default async function OperadoresPage() {
  const ops = await getOperatorIndex();

  const totalActivos = ops.reduce((s, o) => s + o.activos, 0);
  const items: BarItem[] = ops.slice(0, 10).map((o, i) => ({
    label: o.operator,
    value: o.activos,
    color: `var(${CAT[i % CAT.length]})`,
  }));

  return (
    <>
      <div className="page-head">
        <h1 style={{ fontSize: 22 }}>Por operador</h1>
        <p className="secondary" style={{ marginTop: 4, fontSize: 13.5 }}>
          Participación de cada operador y su balance de portabilidad. El neto es
          ganados menos perdidos.
        </p>
      </div>

      <section
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}
      >
        <StatTile label="Operadores" value={ops.length} hint="con números activos" />
        <StatTile label="Números activos" value={totalActivos} />
        <StatTile
          label="Líder"
          value={ops[0]?.activos ?? 0}
          hint={ops[0]?.operator ?? "—"}
        />
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr 1fr", alignItems: "start" }}>
        <BarList items={items} title="Números activos por operador" unit="números" />

        <div className="card">
          <h3 style={{ fontSize: 15 }}>Balance de portabilidad</h3>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Neto = ganados − perdidos. Verde gana suscriptores, rojo los pierde.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
            {(() => {
              const top = ops.slice(0, 10);
              const netos = top.map((x) => x.ganados - x.perdidos);
              // El eje solo se centra en cero si de verdad hay netos negativos.
              // Si todos son positivos, un eje central desperdiciaria la mitad
              // del ancho y sugeriria una simetria que no existe.
              const hayNegativos = netos.some((n) => n < 0);
              const max = Math.max(1, ...netos.map(Math.abs));
              const cero = hayNegativos ? 50 : 0;

              return top.map((o) => {
                const neto = o.ganados - o.perdidos;
                const positivo = neto >= 0;
                const pct = (Math.abs(neto) / max) * (hayNegativos ? 50 : 100);
                return (
                  <div key={o.operator} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span className="secondary" style={{ fontWeight: 500 }}>
                        {o.operator}
                      </span>
                      <span
                        style={{
                          fontVariantNumeric: "tabular-nums",
                          color: positivo ? "var(--good)" : "var(--critical)",
                          fontWeight: 600,
                        }}
                      >
                        {positivo ? "+" : "−"}
                        {Math.abs(neto).toLocaleString("es-MX")}
                      </span>
                    </div>
                    <div style={{ position: "relative", height: 8, background: "var(--grid)", borderRadius: 4 }}>
                      <div
                        style={{
                          position: "absolute",
                          left: positivo ? `${cero}%` : `${cero - pct}%`,
                          width: `${pct}%`,
                          height: "100%",
                          background: positivo ? "var(--good)" : "var(--critical)",
                          borderRadius: 4,
                        }}
                      />
                      {hayNegativos ? (
                        <div
                          style={{
                            position: "absolute",
                            left: "50%",
                            top: -2,
                            width: 1,
                            height: 12,
                            background: "var(--baseline)",
                          }}
                        />
                      ) : null}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </section>

      <section className="card">
        <h3 style={{ fontSize: 15 }}>Detalle por operador</h3>
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Operador</th>
                <th className="num">Activos</th>
                <th className="num">Participación</th>
                <th className="num">Ganados</th>
                <th className="num">Perdidos</th>
                <th className="num">Neto</th>
                <th className="num">Dados de baja</th>
              </tr>
            </thead>
            <tbody>
              {ops.map((o) => {
                const neto = o.ganados - o.perdidos;
                const share = totalActivos ? (o.activos / totalActivos) * 100 : 0;
                return (
                  <tr key={o.operator}>
                    <td>
                      <Link
                        href={`/operador/${encodeURIComponent(o.operator)}`}
                        style={{ textDecoration: "none", fontWeight: 500 }}
                      >
                        {o.operator}
                      </Link>
                    </td>
                    <td className="num">{o.activos.toLocaleString("es-MX")}</td>
                    <td className="num muted">{share.toFixed(1)}%</td>
                    <td className="num">{o.ganados.toLocaleString("es-MX")}</td>
                    <td className="num">{o.perdidos.toLocaleString("es-MX")}</td>
                    <td
                      className="num"
                      style={{ color: neto >= 0 ? "var(--good)" : "var(--critical)", fontWeight: 600 }}
                    >
                      {neto >= 0 ? "+" : "−"}
                      {Math.abs(neto).toLocaleString("es-MX")}
                    </td>
                    <td className="num">{o.bajas.toLocaleString("es-MX")}</td>
                  </tr>
                );
              })}
              {ops.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
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
