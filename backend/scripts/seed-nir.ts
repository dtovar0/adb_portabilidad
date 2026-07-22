// Carga el catalogo NIR -> estado (data/nir_estado.csv) en la tabla nir_catalog.
// Idempotente: hace upsert por NIR, asi que puede correrse cuantas veces se quiera.
//
// Uso: npm run seed:nir
import { prisma } from "../src/prisma.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const csvPath = join(here, "..", "data", "nir_estado.csv");

function parseCsv(text: string): { nir: string; state: string; population: string | null }[] {
  const rows: { nir: string; state: string; population: string | null }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    // saltar header y lineas vacias
    const line = lines[i];
    if (!line.trim()) continue;
    // CSV simple: nir,estado,poblacion (la poblacion puede traer comas? no en este
    // catalogo, pero por seguridad unimos el resto como poblacion).
    const first = line.indexOf(",");
    const second = line.indexOf(",", first + 1);
    if (first === -1) continue;
    const nir = line.slice(0, first).trim();
    const state = (second === -1 ? line.slice(first + 1) : line.slice(first + 1, second)).trim();
    const pop = second === -1 ? "" : line.slice(second + 1).trim();
    if (!nir || !state) continue;
    rows.push({ nir, state, population: pop || null });
  }
  return rows;
}

async function main() {
  const text = readFileSync(csvPath, "utf8");
  const rows = parseCsv(text);
  console.log(`[seed:nir] Leidos ${rows.length} NIRs de ${csvPath}`);

  let n = 0;
  for (const r of rows) {
    await prisma.nirCatalog.upsert({
      where: { nir: r.nir },
      create: r,
      update: { state: r.state, population: r.population },
    });
    n++;
  }
  const total = await prisma.nirCatalog.count();
  console.log(`[seed:nir] Upsert de ${n} NIRs. Total en la BD: ${total}.`);
}

main()
  .catch((e) => {
    console.error("[seed:nir] Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
