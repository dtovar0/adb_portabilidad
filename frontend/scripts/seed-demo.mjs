// Seed de DATOS FICTICIOS para desarrollo/demo del dashboard.
//
// NO usa datos reales del ABD/PSX: genera numeros, eventos y corridas
// verosimiles a partir del catalogo NIR real (backend/data/nir_estado.csv),
// para poder levantar y ver el dashboard sin depender de una sincronizacion.
//
// Uso:  DB_PROVIDER=mysql node scripts/seed-demo.mjs [cantidad]
// Idempotente: limpia las 4 tablas antes de sembrar.
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

const N = Number(process.argv[2] || 15000); // cuantos numeros generar

// PRNG determinista (mismo seed => mismos datos) para reproducibilidad.
let _s = 987654321;
const rnd = () => (_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// --- Operadores con peso (participacion de mercado ficticia) ---
const OPERADORES = [
  ["Telcel", 38], ["AT&T", 21], ["Movistar", 15], ["Bait", 10],
  ["Unefón", 5], ["Virgin Mobile", 3], ["Weex", 2], ["Otros", 6],
];
const opPool = OPERADORES.flatMap(([o, w]) => Array(w).fill(o));

// --- Catalogo NIR real desde el CSV del backend ---
function cargarNir() {
  const csv = readFileSync(join(here, "..", "..", "backend", "data", "nir_estado.csv"), "utf8");
  const lineas = csv.trim().split(/\r?\n/).slice(1); // salta header
  const cat = [];
  for (const ln of lineas) {
    const [nir, estado, poblacion] = ln.split(",");
    if (!nir || !estado) continue;
    cat.push({ nir: nir.trim(), state: estado.trim(), population: (poblacion || "").trim() || null });
  }
  return cat;
}

// Modalidad segun longitud del NIR (regla IFT aproximada para la demo):
// NIR de 2 digitos (55/33/81) => grandes zonas; el resto 3 digitos.
function modalidadPara() {
  const r = rnd();
  if (r < 0.68) return "CPP";  // movil mas comun
  if (r < 0.88) return "FIJO";
  if (r < 0.98) return "MPP";
  return null;                 // sin dato ocasional
}

function numeroDe(nir) {
  const faltan = 10 - nir.length;
  let resto = "";
  for (let i = 0; i < faltan; i++) resto += int(0, 9);
  return nir + resto;
}

// Fecha ficticia entre 2021-01 y 2026-07 (ms epoch fijos, sin Date.now()).
const T_MIN = Date.parse("2021-01-01T00:00:00Z");
const T_MAX = Date.parse("2026-07-20T00:00:00Z");
const fechaRnd = () => new Date(T_MIN + Math.floor(rnd() * (T_MAX - T_MIN)));

async function main() {
  console.log(`[seed-demo] Generando ${N} numeros ficticios...`);
  const nirCat = cargarNir();
  console.log(`[seed-demo] Catalogo NIR: ${nirCat.length} entradas.`);

  // 1) Limpieza (respeta el FK: eventos antes que numbers).
  await prisma.numberEvent.deleteMany();
  await prisma.number.deleteMany();
  await prisma.nirCatalog.deleteMany();
  await prisma.syncRun.deleteMany();

  // 2) Catalogo NIR.
  await prisma.nirCatalog.createMany({ data: nirCat, skipDuplicates: true });

  // 3) Numeros + eventos.
  const usados = new Set();
  const numbers = [];
  const events = [];

  for (let i = 0; i < N; i++) {
    const cat = pick(nirCat);
    let numero;
    do { numero = numeroDe(cat.nir); } while (usados.has(numero));
    usados.add(numero);

    const modalidad = modalidadPara();
    const firstSeen = fechaRnd();
    // Cuantos cambios ha tenido: la mayoria 0-1, cola larga hasta 7.
    const cambios = Math.floor(Math.pow(rnd(), 2.4) * 8);
    const dadoBaja = rnd() < 0.07; // ~7% dados de baja
    const status = dadoBaja ? "deleted" : "active";

    // Cadena de operadores del historial (el ultimo es el operador actual).
    const cadena = [pick(opPool)];
    for (let k = 0; k < cambios; k++) {
      let sig; do { sig = pick(opPool); } while (sig === cadena[cadena.length - 1]);
      cadena.push(sig);
    }
    const operator = cadena[cadena.length - 1];

    let t = firstSeen.getTime();
    const paso = () => { t += int(20, 400) * 86400000; return new Date(Math.min(t, T_MAX)); };

    // Evento de alta (PORTED).
    events.push({
      number: numero, eventType: "PORTED", operatorFrom: null, operatorTo: cadena[0],
      source: "CSV_PORTED", runLabel: "seed-demo", occurredAt: firstSeen,
    });
    // Cambios de operador.
    for (let k = 1; k < cadena.length; k++) {
      events.push({
        number: numero, eventType: "OPERATOR_CHANGE",
        operatorFrom: cadena[k - 1], operatorTo: cadena[k],
        source: "ABD", runLabel: "seed-demo", occurredAt: paso(),
      });
    }
    let lastChange = events[events.length - 1].occurredAt;
    // Baja opcional.
    if (dadoBaja) {
      const bajaAt = paso();
      events.push({
        number: numero, eventType: "DELETED", operatorFrom: operator, operatorTo: null,
        source: "CSV_DELETED", runLabel: "seed-demo", occurredAt: bajaAt,
      });
      lastChange = bajaAt;
    }

    numbers.push({
      number: numero, operator, nir: cat.nir, state: cat.state,
      municipality: cat.population, modalidad, status,
      changeCount: cambios, firstSeenAt: firstSeen, lastChangeAt: lastChange,
    });
  }

  // Inserta por lotes (MySQL: evita paquetes enormes).
  const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  for (const lote of chunk(numbers, 1000)) await prisma.number.createMany({ data: lote });
  console.log(`[seed-demo] ${numbers.length} numeros insertados.`);
  for (const lote of chunk(events, 2000)) await prisma.numberEvent.createMany({ data: lote });
  console.log(`[seed-demo] ${events.length} eventos insertados.`);

  // 4) Corridas de sincronizacion (para el KPI "Sincronizaciones").
  const runs = [];
  for (let i = 0; i < 12; i++) {
    const started = fechaRnd();
    runs.push({
      source: pick(["abd", "psx", "csv"]), runLabel: `run-${i + 1}`,
      startedAt: started, finishedAt: new Date(started.getTime() + int(30, 600) * 1000),
      status: rnd() < 0.9 ? "ok" : "error",
      totalSeen: int(10000, 20000), inserted: int(0, 500),
      updated: int(0, 300), deleted: int(0, 80), opChanges: int(0, 200),
    });
  }
  await prisma.syncRun.createMany({ data: runs });
  console.log(`[seed-demo] ${runs.length} corridas insertadas.`);

  console.log("[seed-demo] Listo. Datos ficticios cargados.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
