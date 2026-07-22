// Sincroniza la BD de tracking desde una fuente (ABD o PSX) y registra el
// historial de cambios.
//
// Uso:
//   npm run sync -- --source abd   [--label 2026-07-21]
//   npm run sync -- --source psx   [--label ...]
//
// Que hace:
//   1. Lee TODA la fuente (streaming) -> mapa {numero: operador}.
//   2. La compara contra el estado actual de la tabla `numbers`.
//   3. Aplica y registra eventos:
//        - numero nuevo (en fuente, no en BD)      -> PORTED  (insert)
//        - operador distinto                        -> OPERATOR_CHANGE (update)
//        - numero ausente (en BD activo, no fuente) -> DELETED (baja logica)
//      Cada evento incrementa changeCount y actualiza lastChangeAt.
//   4. Enriquece cada numero con NIR -> estado (catalogo IFT) y modalidad se
//      deja para la ingesta de CSV/IFT (aqui la fuente no la trae).
//
// Nota de escala: carga en memoria el mapa {numero:operador} de la fuente. Son
// numeros de 10 digitos + operador corto; ~decenas de millones caben en unos
// pocos GB. Si hiciera falta, se puede trocear por prefijo como full_sync.py.
import { prisma } from "../src/prisma.js";
import { streamSource } from "../src/sources.js";
import { resolveState, type NirMap } from "../src/geo.js";

type Source = "abd" | "psx";

function parseArgs(argv: string[]): { source: Source; label: string | null } {
  let source: Source | null = null;
  let label: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source") source = argv[++i] as Source;
    else if (argv[i] === "--label") label = argv[++i];
  }
  if (source !== "abd" && source !== "psx") {
    console.error('Uso: npm run sync -- --source <abd|psx> [--label <etiqueta>]');
    process.exit(2);
  }
  return { source, label };
}

async function loadNirMap(): Promise<NirMap> {
  const rows = await prisma.nirCatalog.findMany();
  const map: NirMap = new Map();
  for (const r of rows) map.set(r.nir, { state: r.state, population: r.population });
  if (map.size === 0) {
    console.warn(
      "[sync] Aviso: catalogo NIR vacio. Corre `npm run seed:nir` para clasificar por estado."
    );
  }
  return map;
}

async function main() {
  const { source, label } = parseArgs(process.argv.slice(2));
  console.log(`[sync] Fuente=${source} label=${label ?? "(sin etiqueta)"}`);

  const nirMap = await loadNirMap();

  const run = await prisma.syncRun.create({
    data: { source, runLabel: label, status: "running" },
  });

  try {
    // 1. Leer la fuente completa a un mapa en memoria.
    console.log(`[sync] Leyendo fuente ${source} ...`);
    const src = new Map<string, string>(); // numero -> operador
    let seen = 0;
    for await (const row of streamSource(source)) {
      src.set(row.number, row.operator);
      seen++;
      if (seen % 500000 === 0) console.log(`[sync]   ${seen.toLocaleString()} filas leidas...`);
    }
    console.log(`[sync] Fuente leida: ${src.size.toLocaleString()} numero(s) unico(s).`);

    // 2. Cargar el estado actual de la BD (solo numero, operador, status).
    console.log(`[sync] Cargando estado actual de la BD ...`);
    const current = new Map<string, { operator: string; status: string }>();
    const dbRows = await prisma.number.findMany({
      select: { number: true, operator: true, status: true },
    });
    for (const r of dbRows) current.set(r.number, { operator: r.operator, status: r.status });
    console.log(`[sync] BD actual: ${current.size.toLocaleString()} numero(s).`);

    let inserted = 0;
    let updated = 0;
    let opChanges = 0;
    let deleted = 0;

    const now = new Date();

    // 3a. Altas y cambios de operador (recorriendo la fuente).
    for (const [number, operator] of src) {
      const cur = current.get(number);
      if (!cur) {
        // Numero nuevo -> alta.
        const geo = resolveState(number, nirMap);
        await prisma.number.create({
          data: {
            number,
            operator,
            nir: geo.nir,
            state: geo.state,
            municipality: geo.municipality,
            status: "active",
            changeCount: 0,
            firstSeenAt: now,
            lastChangeAt: now,
            events: {
              create: {
                eventType: "PORTED",
                operatorTo: operator,
                source: source.toUpperCase(),
                runLabel: label,
                occurredAt: now,
              },
            },
          },
        });
        inserted++;
      } else if (cur.operator !== operator || cur.status !== "active") {
        // Cambio de operador y/o reactivacion de un numero antes dado de baja.
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
                source: source.toUpperCase(),
                runLabel: label,
                occurredAt: now,
              },
            },
          },
        });
        updated++;
        if (isOpChange) opChanges++;
      }
      // else: identico, nada que hacer.
    }

    // 3b. Bajas: activos en BD que ya no estan en la fuente.
    for (const [number, cur] of current) {
      if (cur.status !== "active") continue;
      if (src.has(number)) continue;
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
              source: source.toUpperCase(),
              runLabel: label,
              occurredAt: now,
            },
          },
        },
      });
      deleted++;
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
      `[sync] LISTO. altas=${inserted} cambios=${updated} (de operador=${opChanges}) bajas=${deleted}.`
    );
  } catch (e: any) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: "error", errorMsg: String(e?.message ?? e) },
    });
    console.error("[sync] Error:", e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
