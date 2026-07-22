import { prisma } from "./prisma";

/** KPIs de cabecera del dashboard. */
export async function getKpis() {
  const [activos, dadosDeBaja, totalEventos, cambiosOperador, corridas] = await Promise.all([
    prisma.number.count({ where: { status: "active" } }),
    prisma.number.count({ where: { status: "deleted" } }),
    prisma.numberEvent.count(),
    prisma.numberEvent.count({ where: { eventType: "OPERATOR_CHANGE" } }),
    prisma.syncRun.count({ where: { status: "ok" } }),
  ]);
  return { activos, dadosDeBaja, totalEventos, cambiosOperador, corridas };
}

/** Cantidad de numeros activos por estado (para el mapa y la tabla). */
export async function getByState() {
  const rows = await prisma.number.groupBy({
    by: ["state"],
    where: { status: "active" },
    _count: { _all: true },
  });
  return rows
    .map((r) => ({ state: r.state ?? "Sin identificar", count: r._count._all }))
    .sort((a, b) => b.count - a.count);
}

/** Distribucion de numeros activos por operador (top N + "Otros"). */
export async function getByOperator(topN = 8) {
  const rows = await prisma.number.groupBy({
    by: ["operator"],
    where: { status: "active" },
    _count: { _all: true },
  });
  const sorted = rows
    .map((r) => ({ operator: r.operator, count: r._count._all }))
    .sort((a, b) => b.count - a.count);
  if (sorted.length <= topN) return sorted;
  const top = sorted.slice(0, topN);
  const otros = sorted.slice(topN).reduce((s, r) => s + r.count, 0);
  return [...top, { operator: "Otros", count: otros }];
}

/** Distribucion por modalidad (FIJO / CPP movil / MPP / sin dato). */
export async function getByModalidad() {
  const rows = await prisma.number.groupBy({
    by: ["modalidad"],
    where: { status: "active" },
    _count: { _all: true },
  });
  return rows
    .map((r) => ({ modalidad: r.modalidad ?? "Sin dato", count: r._count._all }))
    .sort((a, b) => b.count - a.count);
}

/** Serie temporal de altas vs bajas por corrida (runLabel) o por dia. */
export async function getTimeline() {
  // Agrupa eventos por dia y tipo. Usamos SQL crudo por portabilidad PG/MySQL:
  // ambos soportan DATE() sobre timestamp, pero la sintaxis difiere; para
  // mantenerlo simple agregamos en JS a partir de los eventos recientes.
  const events = await prisma.numberEvent.findMany({
    select: { eventType: true, occurredAt: true },
    orderBy: { occurredAt: "asc" },
    take: 50000,
  });
  const byDay = new Map<string, { ported: number; deleted: number; opChange: number }>();
  for (const e of events) {
    const day = e.occurredAt.toISOString().slice(0, 10);
    const b = byDay.get(day) ?? { ported: 0, deleted: 0, opChange: 0 };
    if (e.eventType === "PORTED") b.ported++;
    else if (e.eventType === "DELETED") b.deleted++;
    else if (e.eventType === "OPERATOR_CHANGE") b.opChange++;
    byDay.set(day, b);
  }
  return Array.from(byDay.entries())
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Historial completo de un numero (para el buscador). */
export async function getNumberHistory(number: string) {
  const num = await prisma.number.findUnique({
    where: { number },
    include: { events: { orderBy: { occurredAt: "desc" } } },
  });
  return num;
}

/** Lista de operadores (activos) con su conteo, para el selector y el indice. */
export async function getOperators() {
  const rows = await prisma.number.groupBy({
    by: ["operator"],
    where: { status: "active" },
    _count: { _all: true },
  });
  return rows
    .map((r) => ({ operator: r.operator, count: r._count._all }))
    .sort((a, b) => b.count - a.count);
}

/** KPIs de un operador especifico. */
export async function getOperatorKpis(operator: string) {
  const [activos, dadosDeBaja, ganados, perdidos] = await Promise.all([
    prisma.number.count({ where: { operator, status: "active" } }),
    prisma.number.count({ where: { operator, status: "deleted" } }),
    // Numeros que llegaron a este operador (alta o cambio hacia el).
    prisma.numberEvent.count({ where: { operatorTo: operator } }),
    // Numeros que se fueron de este operador (cambio desde el).
    prisma.numberEvent.count({ where: { operatorFrom: operator, eventType: "OPERATOR_CHANGE" } }),
  ]);
  return { activos, dadosDeBaja, ganados, perdidos };
}

/** Distribucion por estado de un operador (para su mapa y tabla). */
export async function getOperatorByState(operator: string) {
  const rows = await prisma.number.groupBy({
    by: ["state"],
    where: { operator, status: "active" },
    _count: { _all: true },
  });
  return rows
    .map((r) => ({ state: r.state ?? "Sin identificar", count: r._count._all }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Matriz operador x estado (cruce): conteo de numeros activos por cada par.
 * Devuelve { operators, states, matrix } listo para el heatmap.
 */
export async function getOperatorStateMatrix(topOperators = 8, topStates = 12) {
  const rows = await prisma.number.groupBy({
    by: ["operator", "state"],
    where: { status: "active" },
    _count: { _all: true },
  });

  // Totales para elegir top operadores y top estados.
  const opTotals = new Map<string, number>();
  const stTotals = new Map<string, number>();
  for (const r of rows) {
    const st = r.state ?? "Sin identificar";
    opTotals.set(r.operator, (opTotals.get(r.operator) ?? 0) + r._count._all);
    stTotals.set(st, (stTotals.get(st) ?? 0) + r._count._all);
  }
  const operators = [...opTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topOperators)
    .map(([o]) => o);
  const states = [...stTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topStates)
    .map(([s]) => s);

  const opIdx = new Map(operators.map((o, i) => [o, i]));
  const stIdx = new Map(states.map((s, i) => [s, i]));
  const matrix: number[][] = operators.map(() => states.map(() => 0));
  for (const r of rows) {
    const st = r.state ?? "Sin identificar";
    const oi = opIdx.get(r.operator);
    const si = stIdx.get(st);
    if (oi === undefined || si === undefined) continue;
    matrix[oi][si] = r._count._all;
  }
  return { operators, states, matrix };
}

/** Numeros con mas cambios (ranking de "mas portados"). */
export async function getMostChanged(limit = 15) {
  return prisma.number.findMany({
    orderBy: { changeCount: "desc" },
    take: limit,
    select: {
      number: true,
      operator: true,
      state: true,
      changeCount: true,
      status: true,
      lastChangeAt: true,
    },
  });
}
