# Portabilidad numérica — México

Sincroniza y visualiza el comportamiento de la portabilidad numérica (México,
Country_Id 52) entre la BD del área de Sistemas (ABD, MSSQL, *master*) y el equipo
PSX/SONUS (Oracle, *slave*), con una BD de tracking propia y un dashboard.

## Estructura

```
portabilidad/
├── utils/       Scripts Python de sincronización con el equipo SONUS/EMS
│   ├── full_sync.py      Descarga ABD/PSX, compara y genera/ejecuta CSV de comandos
│   ├── mtysajpsx01.py    Ejecuta los CSV contra el equipo (scp + CLI remoto)
│   └── docs/             Reglas de negocio
├── backend/     BD de tracking (Prisma) + ingesta
│   ├── prisma/schema.prisma   Modelo con historial de cambios e índices
│   ├── data/nir_estado.csv    Catálogo NIR → estado (IFT)
│   ├── src/                   env, prisma, geo (número→estado), fuentes ABD/PSX
│   └── scripts/               set-provider, seed-nir, sync-db, ingest-csv
├── frontend/    Dashboard Next.js (mapa coroplético, operador, historial)
└── .env         Config compartida (raíz) — en .gitignore
```

## Requisitos

- Node.js 20+
- Postgres **o** MySQL corriendo localmente (elegible con `DB_PROVIDER`)
- Python 3.12+ para los scripts de `utils/` (ver `utils/requirements.txt`)

## Base de datos de tracking

El motor se elige con `DB_PROVIDER` (`postgresql` | `mysql`). Prisma no admite
`env()` en el `provider`, así que un script (`db:provider`) reescribe el schema
antes de generar/migrar.

```bash
cd backend
cp .env.example .env            # ajusta DB_PROVIDER y DATABASE_URL
npm install
npm run db:migrate              # crea las tablas (con índices)
npm run seed:nir                # carga el catálogo NIR → estado
```

### Modelo (resumen)

- **numbers** — estado actual de cada número (operador, nir, state, modalidad,
  status, `changeCount`, `firstSeenAt`, `lastChangeAt`).
- **number_events** — historial: `PORTED` / `DELETED` / `OPERATOR_CHANGE`, con
  operador origen/destino, fuente y fecha. Responde *cuándo y cuántas veces
  cambió* un número.
- **nir_catalog** — NIR → estado (IFT).
- **sync_runs** — auditoría de cada ingesta.

## Ingesta

**Primera carga (bootstrap) desde una fuente:**

```bash
cd backend
npm run sync -- --source abd     # lee ABD (MSSQL) → BD de tracking
# o
npm run sync -- --source psx     # lee PSX (Oracle) → BD de tracking
```

**Incremental desde los CSV de full_sync:**

```bash
npm run ingest:csv -- --ported <PREFIX>_PORTED.csv --deleted <PREFIX>_DELETED.csv --label 2026-07-21
# o, por convención (FILE_PREFIX + CSV_DIR del .env):
npm run ingest:csv -- --label 2026-07-21
```

Ambos registran eventos y actualizan `changeCount`. El estado (entidad
federativa) se deriva del NIR del número (primeros 2 dígitos para 55/33/81, 3
para el resto) contra el catálogo del IFT.

## Dashboard

```bash
cd frontend
cp .env.example .env             # mismo DATABASE_URL que el backend
npm install
npm run db:generate              # genera el cliente Prisma (schema del backend)
npm run dev                      # http://localhost:3000
```

Vistas:

- **Home** — KPIs, mapa coroplético por estado, top estados, distribución por
  operador y modalidad, cruce operador × estado (heatmap), buscador de historial,
  ranking de números con más cambios.
- **/operador/[operador]** — vista dedicada: KPIs (activos, ganados, perdidos),
  mapa y top estados de ese operador.

## Notas

- Toda la config de `utils/` (Python) sale del `.env` de la raíz; el backend
  reutiliza ese mismo `.env` (credenciales ABD/PSX) y añade lo suyo en
  `backend/.env`.
- `frontend/scripts/fix-turbopack.mjs` (postinstall) aplica un workaround a un
  bug de Next 15.5 con Turbopack.
