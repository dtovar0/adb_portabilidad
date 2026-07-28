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

/**
 * Estados con su desglose: activos, dados de baja y operador dominante.
 * Alimenta el indice /estados. Se hacen dos groupBy (por estado y por
 * estado+operador) en vez de N consultas por estado.
 */
export async function getStateIndex() {
  const [porEstado, porEstadoOp] = await Promise.all([
    prisma.number.groupBy({
      by: ["state", "status"],
      _count: { _all: true },
    }),
    prisma.number.groupBy({
      by: ["state", "operator"],
      where: { status: "active" },
      _count: { _all: true },
    }),
  ]);

  const acc = new Map<
    string,
    { state: string; activos: number; bajas: number; operadores: Map<string, number> }
  >();
  const get = (s: string | null) => {
    const key = s ?? "Sin identificar";
    let e = acc.get(key);
    if (!e) {
      e = { state: key, activos: 0, bajas: 0, operadores: new Map() };
      acc.set(key, e);
    }
    return e;
  };

  for (const r of porEstado) {
    const e = get(r.state);
    if (r.status === "active") e.activos += r._count._all;
    else e.bajas += r._count._all;
  }
  for (const r of porEstadoOp) {
    const e = get(r.state);
    e.operadores.set(r.operator, (e.operadores.get(r.operator) ?? 0) + r._count._all);
  }

  return [...acc.values()]
    .map((e) => {
      const top = [...e.operadores.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        state: e.state,
        activos: e.activos,
        bajas: e.bajas,
        operadores: e.operadores.size,
        topOperador: top ? top[0] : "—",
        topOperadorCount: top ? top[1] : 0,
      };
    })
    .sort((a, b) => b.activos - a.activos);
}

/** Detalle de un estado: KPIs, operadores y modalidades. */
export async function getStateDetail(state: string) {
  const [activos, bajas, porOperador, porModalidad, nirs] = await Promise.all([
    prisma.number.count({ where: { state, status: "active" } }),
    prisma.number.count({ where: { state, status: "deleted" } }),
    prisma.number.groupBy({
      by: ["operator"],
      where: { state, status: "active" },
      _count: { _all: true },
    }),
    prisma.number.groupBy({
      by: ["modalidad"],
      where: { state, status: "active" },
      _count: { _all: true },
    }),
    prisma.nirCatalog.findMany({ where: { state }, orderBy: { nir: "asc" } }),
  ]);
  return {
    activos,
    bajas,
    operadores: porOperador
      .map((r) => ({ operator: r.operator, count: r._count._all }))
      .sort((a, b) => b.count - a.count),
    modalidades: porModalidad
      .map((r) => ({ modalidad: r.modalidad ?? "Sin dato", count: r._count._all }))
      .sort((a, b) => b.count - a.count),
    nirs,
  };
}

/**
 * Indice de operadores con ganados/perdidos/bajas, para /operadores.
 * Se resuelve con 4 groupBy en lugar de 4 consultas por operador.
 */
export async function getOperatorIndex() {
  const [activos, bajas, ganados, perdidos] = await Promise.all([
    prisma.number.groupBy({
      by: ["operator"],
      where: { status: "active" },
      _count: { _all: true },
    }),
    prisma.number.groupBy({
      by: ["operator"],
      where: { status: "deleted" },
      _count: { _all: true },
    }),
    prisma.numberEvent.groupBy({
      by: ["operatorTo"],
      _count: { _all: true },
    }),
    prisma.numberEvent.groupBy({
      by: ["operatorFrom"],
      where: { eventType: "OPERATOR_CHANGE" },
      _count: { _all: true },
    }),
  ]);

  const acc = new Map<
    string,
    { operator: string; activos: number; bajas: number; ganados: number; perdidos: number }
  >();
  const get = (o: string) => {
    let e = acc.get(o);
    if (!e) {
      e = { operator: o, activos: 0, bajas: 0, ganados: 0, perdidos: 0 };
      acc.set(o, e);
    }
    return e;
  };
  for (const r of activos) get(r.operator).activos = r._count._all;
  for (const r of bajas) get(r.operator).bajas = r._count._all;
  for (const r of ganados) if (r.operatorTo) get(r.operatorTo).ganados = r._count._all;
  for (const r of perdidos) if (r.operatorFrom) get(r.operatorFrom).perdidos = r._count._all;

  return [...acc.values()].sort((a, b) => b.activos - a.activos);
}

/** Corridas de sincronizacion, mas recientes primero. */
export async function getSyncRuns(limit = 100) {
  return prisma.syncRun.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
  });
}

/** Resumen de las corridas para los KPIs de /sincronizaciones. */
export async function getSyncSummary() {
  const [total, ok, error, corriendo, ultima] = await Promise.all([
    prisma.syncRun.count(),
    prisma.syncRun.count({ where: { status: "ok" } }),
    prisma.syncRun.count({ where: { status: "error" } }),
    prisma.syncRun.count({ where: { status: "running" } }),
    prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
  ]);
  return { total, ok, error, corriendo, ultima };
}

/**
 * Historial de eventos paginado, con filtro opcional por tipo.
 * Devuelve las filas y el total para poder paginar.
 */
export async function getEvents({
  page = 1,
  perPage = 50,
  eventType,
}: { page?: number; perPage?: number; eventType?: string } = {}) {
  const where = eventType ? { eventType } : {};
  const [rows, total] = await Promise.all([
    prisma.numberEvent.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.numberEvent.count({ where }),
  ]);
  return { rows, total, page, perPage };
}

/** Conteo de eventos por tipo, para los filtros/KPIs de /eventos. */
export async function getEventTypeCounts() {
  const rows = await prisma.numberEvent.groupBy({
    by: ["eventType"],
    _count: { _all: true },
  });
  return rows
    .map((r) => ({ eventType: r.eventType, count: r._count._all }))
    .sort((a, b) => b.count - a.count);
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
