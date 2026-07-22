"use client";

import { useMemo, useState } from "react";

// Mapa coroplético de México por estado. Sequential blue (magnitud): el paso mas
// claro = cerca de cero, recede hacia la superficie. Hover -> tooltip por estado.
// Recibe el GeoJSON (FeatureCollection) y un mapa nombre_estado -> conteo.

type GeoFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
};
type GeoJSON = { type: "FeatureCollection"; features: GeoFeature[] };

// Rampa secuencial azul (5 pasos). Se resuelven desde CSS vars en runtime? No:
// en SVG fill necesitamos valores; usamos var() que SI funciona en fill.
const RAMP = ["--seq-100", "--seq-250", "--seq-400", "--seq-550", "--seq-700"];

function bucket(value: number, max: number): number {
  if (value <= 0 || max <= 0) return -1;
  const t = value / max;
  if (t <= 0.05) return 0;
  if (t <= 0.2) return 1;
  if (t <= 0.45) return 2;
  if (t <= 0.75) return 3;
  return 4;
}

// Proyeccion equirectangular simple ajustada a la bbox del GeoJSON.
function useProjection(geo: GeoJSON, width: number, height: number) {
  return useMemo(() => {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const visit = (coords: any) => {
      if (typeof coords[0] === "number") {
        const [x, y] = coords;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      } else coords.forEach(visit);
    };
    geo.features.forEach((f) => visit(f.geometry.coordinates));
    const pad = 10;
    const sx = (width - pad * 2) / (maxX - minX || 1);
    const sy = (height - pad * 2) / (maxY - minY || 1);
    const s = Math.min(sx, sy);
    const ox = pad + (width - pad * 2 - s * (maxX - minX)) / 2;
    const oy = pad + (height - pad * 2 - s * (maxY - minY)) / 2;
    // y invertida (lat crece hacia arriba, SVG hacia abajo)
    return (x: number, y: number): [number, number] => [
      ox + (x - minX) * s,
      height - (oy + (y - minY) * s),
    ];
  }, [geo, width, height]);
}

function ring(coords: number[][], project: (x: number, y: number) => [number, number]): string {
  return (
    coords
      .map((c, i) => {
        const [px, py] = project(c[0], c[1]);
        return `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
      })
      .join(" ") + "Z"
  );
}

function featurePath(f: GeoFeature, project: (x: number, y: number) => [number, number]): string {
  if (f.geometry.type === "Polygon") {
    return (f.geometry.coordinates as number[][][]).map((r) => ring(r, project)).join(" ");
  }
  return (f.geometry.coordinates as number[][][][])
    .flatMap((poly) => poly.map((r) => ring(r, project)))
    .join(" ");
}

export function Choropleth({
  geo,
  counts,
  nameKey,
  nameMap = {},
}: {
  geo: GeoJSON;
  counts: Record<string, number>;
  /** propiedad del GeoJSON que trae el nombre del estado */
  nameKey: string;
  /** mapa nombre_en_geojson -> nombre_en_datos (si difieren) */
  nameMap?: Record<string, string>;
}) {
  const W = 760;
  const H = 460;
  const project = useProjection(geo, W, H);
  const [hover, setHover] = useState<{ name: string; count: number; x: number; y: number } | null>(
    null
  );

  const max = Math.max(1, ...Object.values(counts));

  return (
    <div className="card" style={{ position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ fontSize: 15 }}>Números activos por estado</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          pasa el cursor por un estado
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", marginTop: 8 }}
        role="img"
        aria-label="Mapa de México con números portados por estado"
      >
        {geo.features.map((f, idx) => {
          const rawName = String(f.properties[nameKey] ?? "");
          const dataName = nameMap[rawName] ?? rawName;
          const count = counts[dataName] ?? 0;
          const b = bucket(count, max);
          const fill = b < 0 ? "var(--grid)" : `var(${RAMP[b]})`;
          return (
            <path
              key={idx}
              d={featurePath(f, project)}
              fill={fill}
              stroke="var(--surface-1)"
              strokeWidth={0.8}
              onMouseEnter={(e) => {
                const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                setHover({
                  name: dataName,
                  count,
                  x: e.clientX - rect.left,
                  y: e.clientY - rect.top,
                });
              }}
              onMouseMove={(e) => {
                const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                setHover((h) =>
                  h ? { ...h, x: e.clientX - rect.left, y: e.clientY - rect.top } : h
                );
              }}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: "pointer" }}
            />
          );
        })}
      </svg>

      {/* Leyenda de la rampa */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
        <span className="muted" style={{ fontSize: 11 }}>
          menos
        </span>
        {RAMP.map((r) => (
          <span
            key={r}
            style={{ width: 26, height: 10, borderRadius: 2, background: `var(${r})` }}
          />
        ))}
        <span className="muted" style={{ fontSize: 11 }}>
          más
        </span>
      </div>

      {hover ? (
        <div
          style={{
            position: "absolute",
            left: Math.min(hover.x + 12, W - 40),
            top: hover.y + 12,
            background: "var(--surface-1)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 13,
            pointerEvents: "none",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            whiteSpace: "nowrap",
          }}
        >
          <strong>{hover.name}</strong>
          <br />
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {hover.count.toLocaleString("es-MX")} números
          </span>
        </div>
      ) : null}
    </div>
  );
}
