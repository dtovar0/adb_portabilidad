// Ingesta INCREMENTAL desde los CSV que genera utils/full_sync.py.
//
// full_sync.py produce, por corrida:
//   <PREFIX>_PORTED[_<label>].csv   -> lineas de comando `put`    (altas)
//   <PREFIX>_DELETED[_<label>].csv  -> lineas de comando `delete` (bajas)
//
// De cada linea se extrae numero y (en el put) operador, y se aplica a la BD de
// tracking registrando eventos, igual que sync-db pero a partir del delta ya
// calculado por full_sync (no re-lee ABD/PSX).
//
// Uso:
//   npm run ingest:csv -- --ported <ruta_PORTED.csv> [--deleted <ruta_DELETED.csv>] [--label X]
//   npm run ingest:csv -- --label 2026-07-21   (busca los CSV por PREFIX+label en CSV_DIR)
import { prisma } from "../src/prisma.js";
import { env } from "../src/env.js";
import { resolveState, type NirMap } from "../src/geo.js";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

function parseArgs(argv: string[]) {
  let ported: string | null = null;
  let deleted: string | null = null;
  let label: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ported") ported = argv[++i];
    else if (argv[i] === "--deleted") deleted = argv[++i];
    else if (argv[i] === "--label") label = argv[++i];
  }
  return { ported, deleted, label };
}

/** Extrae `National_Id <num>` de una linea de comando put/delete. */
function extractNumber(line: string): string | null {
  const m = line.match(/National_Id\s+(\d{6,15})/);
  return m ? m[1] : null;
}

/** Extrae el operador (3 primeros chars de Translated_National_Id) de un put. */
function extractOperator(line: string, num: string): string | null {
  // Translated_National_Id = {operator}{TRANSLATED_PREFIX=177}{num}
  const m = line.match(/Translated_National_Id\s+(\S+)/);
  if (!m) return null;
  const tni = m[1];
  // El operador son los caracteres antes de "177"+num; de forma robusta tomamos
  // los 3 primeros, que es como los deriva el PSX y el propio full_sync.
  return tni.slice(0, 3);
}

async function loadNirMap(): Promise<NirMap> {
  const rows = await prisma.nirCatalog.findMany();
  const map: NirMap = new Map();
  for (const r of rows) map.set(r.nir, { state: r.state, population: r.population });
  return map;
}

async function* readLines(path: string) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) yield line;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolver rutas por convencion si no se pasan explicitas.
  let portedPath = args.ported;
  let deletedPath = args.deleted;
  if (!portedPath && !deletedPath) {
    const prefix = env("FILE_PREFIX");
    const dir = env("CSV_DIR") || env("SYNC_WORKDIR") || env("DIRFILES");
    if (!prefix || !dir) {
      console.error(
        "Uso: npm run ingest:csv -- --ported <archivo> [--deleted <archivo>] [--label X]\n" +
          "  o define FILE_PREFIX y CSV_DIR/DIRFILES en el .env y pasa --label."
      );
      process.exit(2);
    }
    const suf = args.label ? `_${args.label}` : "";
    portedPath = join(dir, `${prefix}_PORTED${suf}.csv`);
    deletedPath = join(dir, `${prefix}_DELETED${suf}.csv`);
  }

  const nirMap = await loadNirMap();
  const run = await prisma.syncRun.create({
    data: { source: "csv", runLabel: args.label, status: "running" },
  });

  const now = new Date();
  let inserted = 0;
  let updated = 0;
  let opChanges = 0;
  let deleted = 0;
  let seen = 0;

  try {
    // --- Altas / cambios de operador (PORTED) ---
    if (portedPath && existsSync(portedPath)) {
      console.log(`[ingest:csv] PORTED: ${portedPath}`);
      for await (const line of readLines(portedPath)) {
        const number = extractNumber(line);
        if (!number) continue;
        const operator = extractOperator(line, number) ?? "";
        seen++;
        const cur = await prisma.number.findUnique({
          where: { number },
          select: { operator: true, status: true },
        });
        if (!cur) {
          const geo = resolveState(number, nirMap);
          await prisma.number.create({
            data: {
              number,
              operator,
              nir: geo.nir,
              state: geo.state,
              municipality: geo.municipality,
              status: "active",
              firstSeenAt: now,
              lastChangeAt: now,
              events: {
                create: {
                  eventType: "PORTED",
                  operatorTo: operator,
                  source: "CSV_PORTED",
                  runLabel: args.label,
                  occurredAt: now,
                },
              },
            },
          });
          inserted++;
        } else if (cur.operator !== operator || cur.status !== "active") {
          const isOpChange = cur.operator !== operator;
          await prisma.number.update({
            where: { number },
            data: {
              operator,
              status: "active",
              changeCount: { increment: 1 },
              lastChangeAt: now,
              events: {
                create: {
                  eventType: isOpChange ? "OPERATOR_CHANGE" : "PORTED",
                  operatorFrom: cur.operator,
                  operatorTo: operator,
                  source: "CSV_PORTED",
                  runLabel: args.label,
                  occurredAt: now,
                },
              },
            },
          });
          updated++;
          if (isOpChange) opChanges++;
        }
      }
    } else if (portedPath) {
      console.warn(`[ingest:csv] Aviso: no existe ${portedPath}, se omiten altas.`);
    }

    // --- Bajas (DELETED) ---
    if (deletedPath && existsSync(deletedPath)) {
      console.log(`[ingest:csv] DELETED: ${deletedPath}`);
      for await (const line of readLines(deletedPath)) {
        const number = extractNumber(line);
        if (!number) continue;
        seen++;
        const cur = await prisma.number.findUnique({
          where: { number },
          select: { operator: true, status: true },
        });
        if (cur && cur.status === "active") {
          await prisma.number.update({
            where: { number },
            data: {
              status: "deleted",
              changeCount: { increment: 1 },
              lastChangeAt: now,
              events: {
                create: {
                  eventType: "DELETED",
                  operatorFrom: cur.operator,
                  source: "CSV_DELETED",
                  runLabel: args.label,
                  occurredAt: now,
                },
              },
            },
          });
          deleted++;
        }
      }
    } else if (deletedPath) {
      console.warn(`[ingest:csv] Aviso: no existe ${deletedPath}, se omiten bajas.`);
    }

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: "ok",
        totalSeen: seen,
        inserted,
        updated,
        deleted,
        opChanges,
      },
    });
    console.log(
      `[ingest:csv] LISTO. altas=${inserted} cambios=${updated} (operador=${opChanges}) bajas=${deleted}.`
    );
  } catch (e: any) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: "error", errorMsg: String(e?.message ?? e) },
    });
    console.error("[ingest:csv] Error:", e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
