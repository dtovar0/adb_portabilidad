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
│   ├── run_diario.sh     Wrapper de cron para el diario (mtysajpsx01)
│   ├── run_full_sync.sh  Wrapper de cron para el full sync
│   ├── entorno.sh        venv + PATH compartido por los wrappers
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

## Sincronización con el equipo (utils/)

Dos procesos distintos, ambos generan comandos CLI y los ejecutan contra el
equipo (scp + `execute batch_script`, en partes de `CHUNK_SIZE` con reintentos,
recuperación y checkpoint):

```bash
# Diario: portabilidad de una fecha (PORTED y DELETED)
python mtysajpsx01.py --date 20260727
python mtysajpsx01.py --date-from 20260701 --date-to 20260727   # un rango
python mtysajpsx01.py --date 20260727 --type PORTED             # solo altas

# Full sync: snapshot completo, compara ABD vs PSX (sin fechas)
python full_sync.py
python full_sync.py --no-execute    # solo genera los CSV, no toca el equipo
python full_sync.py --check         # solo compara conteos (sale 1 si no cuadran)
```

El diario **va un día atrás**: el CSV de un día se genera al día siguiente, así
que rechaza cualquier fecha `>= hoy`. Los domingos y festivos se omiten según
`SKIP_SUNDAY` / `SKIP_HOLIDAYS` (evaluados contra la fecha del *dato*, no la de
ejecución).

### Alta en cron

Cron **no** es un shell de login: arranca con `PATH` mínimo, sin las variables
del perfil, con el cwd en `$HOME` y **sin el venv activado**. Por eso no se
invoca el `.py` directo, sino los wrappers de `utils/`, que fijan ese entorno:

| Wrapper | Ejecuta | Notas |
| --- | --- | --- |
| `run_diario.sh` | `mtysajpsx01.py` | Si no le pasas fecha, usa **ayer** |
| `run_full_sync.sh` | `full_sync.py` | Sin fechas (snapshot completo) |
| `entorno.sh` | — | venv + `PATH` compartido; se incluye, no se ejecuta |

Da de alta las tareas con `crontab -e` **como el usuario que debe correrlas**
(si el `.env` define `RUN_AS_USER`, el script aborta si no coincide):

```cron
VENV_DIR=/ruta/a/tu/venv

# Diario, 2:30 AM: procesa AYER (PORTED y DELETED)
30 2 * * * /home/dtovar/bayblade/portabilidad/utils/run_diario.sh >> /home/dtovar/bayblade/portabilidad/logs/diario_$(date +\%Y\%m\%d).log 2>&1

# Full sync, domingos 4:00 AM
0 4 * * 0 /home/dtovar/bayblade/portabilidad/utils/run_full_sync.sh >> /home/dtovar/bayblade/portabilidad/logs/full_sync_$(date +\%Y\%m\%d).log 2>&1
```

Antes del primer disparo:

```bash
mkdir -p logs                       # cron no crea el directorio del log
utils/run_full_sync.sh --check      # valida credenciales y conexión a ambas BD
```

Detalles que suelen morder:

- **Escapa los `%`** (`\%`) en el crontab: sin escapar, cron los interpreta como
  salto de línea y la tarea falla.
- **El venv** se busca en `VENV_DIR`, `<repo>/venv`, `<repo>/.venv` y
  `$HOME/venv`. Si está en el repo puedes omitir la línea `VENV_DIR`. Si no
  encuentra ninguno, avisa por stderr y cae al `python3` del sistema.
- **Llaves SSH sin passphrase**: bajo cron no hay agente SSH, así que un `scp`
  con llave protegida se queda colgado. Para simular ese entorno (más hostil que
  cron, porque `env -i` borra incluso el `PATH`), usa rutas absolutas:
  `env -i HOME=$HOME /bin/bash -c "$PWD/utils/run_diario.sh --date 20260727"`.
- **Sin corridas solapadas**: cada wrapper toma su propio cerrojo (`flock -n`) y
  sale sin hacer nada si ya hay una corriendo, para que dos procesos no peleen
  por los mismos CSV, el checkpoint y la sesión CLI. El diario y el full sync
  usan cerrojos distintos, así que no se bloquean entre sí.
- **El crontab correcto**: `DIRFILES` / `LOG_DIR` del `.env` suelen apuntar al
  home de un usuario de servicio (p. ej. `airflow`). El crontab tiene que ser el
  de **ese** usuario (`sudo -u airflow crontab -e`), o el proceso fallará al
  crear los directorios de trabajo. Ojo con los typos en esas rutas: con
  `CREATE_DIRS=true` el script crea el directorio mal escrito sin avisar, y el
  checkpoint se va con él si `CHECKPOINT_DIR` está vacío (hereda `LOG_DIR`).
- **Reanudación**: si una parte falla, se reintenta recortando el batch desde
  donde el EMS se quedó (`RESUME_PARTIAL`, `RESUME_TOLERANCE`). Si el proceso
  muere, el checkpoint permite retomar sin repetir las partes ya completadas.

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
- **/estados** — mapa y tabla por entidad (activos, participación, bajas,
  operador dominante); cada fila entra a **/estados/[estado]**, con sus
  operadores, modalidades y los NIR del catálogo IFT.
- **/operadores** — índice con balance de portabilidad (ganados, perdidos, neto);
  enlaza a **/operador/[operador]**, la vista dedicada con KPIs, mapa y top
  estados de ese operador.
- **/sincronizaciones** — última corrida e historial de `sync_runs` (estado,
  duración, registros vistos/nuevos/actualizados).
- **/eventos** — historial paginado de altas, bajas y cambios de operador, con
  filtro por tipo.

## Notas

- Toda la config de `utils/` (Python) sale del `.env` de la raíz; el backend
  reutiliza ese mismo `.env` (credenciales ABD/PSX) y añade lo suyo en
  `backend/.env`.
- `frontend/scripts/fix-turbopack.mjs` (postinstall) aplica un workaround a un
  bug de Next 15.5 con Turbopack.
