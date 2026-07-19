# 📚 Reglas de Negocio — Portabilidad

---

## Módulo: General

### Regla: Proceso de Portabilidad
**Descripción:** Sistema de sincronización y portabilidad de datos entre bases de datos (MSSQL/Oracle) y equipos SONUS/PSX.

### Ejemplo
Ejecución programada del script `mtysajpsx01.py` para sincronizar configuraciones contra el equipo PSX, y `full_sync.py` para comparar y generar diferencias entre bases de datos.

### Impacto
Sistemas afectados: Base de datos ABD (MSSQL), Base de datos PSX (Oracle), Equipo SONUS/EMS.

---

## Módulo: Configuración

### Regla: Toda la configuración proviene del .env
**Descripción:** Ningún dato de despliegue (servidores, credenciales, rutas, correos, constantes del protocolo CLI) debe estar hardcodeado en el código. Todo se lee del `.env`. Al arrancar, cada script valida que las variables obligatorias estén definidas y aborta con código 2 y un mensaje claro si falta alguna, en lugar de fallar de forma confusa más adelante.

### Ejemplo
`full_sync.py` y `mtysajpsx01.py` leen sus parámetros con `os.environ.get(...)`; si falta, por ejemplo, `SSH_HOST` o `ABD_PASSWORD`, el proceso imprime `[ERROR] Faltan variables obligatorias en el .env: ...` y termina. El `.env` real está en `.gitignore` (contiene secretos); `.env.example` es la plantilla versionada sin secretos.

### Impacto
Sistemas afectados: `full_sync.py`, `mtysajpsx01.py`, `.env`, `.env.example`.

---

## Módulo: Full Sync

### Regla: El Full Sync compara SIEMPRE toda la numeración (ABD master, PSX slave)
**Descripción:** El full sync compara las dos tablas completas de números. ABD (Sistemas/MSSQL) es el **master** y PSX (Oracle) el **slave**: el estado del PSX debe igualar al del ABD. Las diferencias son bidireccionales: número en ABD y no en PSX → alta (`PORTED`/put); número en PSX y no en ABD → baja (`DELETED`/delete). El loteo por prefijo (base 2..9, `SYNC_DEPTH`) es solo para controlar memoria; NO es un subconjunto: debe cubrir toda la numeración, porque omitir un prefijo provocaría bajas/borrados indebidos.

### Ejemplo
`python3 full_sync.py` descarga ambas tablas completas, calcula las diferencias y genera `MTYSAJPSX01_PORTED.csv` y `MTYSAJPSX01_DELETED.csv`.

### Impacto
Sistemas afectados: Base de datos ABD (MSSQL), Base de datos PSX (Oracle).

---

### Regla: El Full Sync es un snapshot total, no maneja fechas
**Descripción:** El full sync no filtra por fecha: siempre es un snapshot del estado total de ambas tablas al momento de ejecutarse. Los CSV que genera se nombran `<FILE_PREFIX>_<TYPE>[_<label>].csv` con una etiqueta opcional (`--label`) para distinguir corridas; sin etiqueta, se sobrescriben. El manejo por fecha (día a día, con calendario) es competencia exclusiva de `mtysajpsx01.py`, no del full sync.

### Ejemplo
`python3 full_sync.py --label prueba` genera `MTYSAJPSX01_PORTED_prueba.csv`. `python3 full_sync.py` (sin etiqueta) genera/sobrescribe `MTYSAJPSX01_PORTED.csv`.

### Impacto
Sistemas afectados: `full_sync.py`, `mtysajpsx01.py`.

---

### Regla: El Full Sync genera y ejecuta en un solo paso
**Descripción:** `full_sync.py` orquesta todo el flujo: descarga ambas bases, genera las diferencias y las ejecuta contra el equipo reutilizando el pipeline de `mtysajpsx01.py` (chunks, reintentos, recuperación/reboot y checkpoint) para `PORTED` y `DELETED`. Con `--no-execute` solo genera los CSV sin aplicarlos. Antes de descargar, si va a ejecutar, valida también la configuración de portabilidad para fallar temprano.

### Ejemplo
`python3 full_sync.py` descarga, compara y aplica. `python3 full_sync.py --no-execute` solo genera los CSV.

### Impacto
Sistemas afectados: `full_sync.py`, `mtysajpsx01.py`, Equipo SONUS/EMS.

---

### Regla: Chequeo master/slave por cantidad de registros
**Descripción:** `full_sync.py --check` valida rápidamente (SELECT COUNT(*), sin descargar ni comparar) que el PSX (slave) tenga la misma cantidad de registros que el ABD (master). Indica si faltan o sobran registros en el PSX y termina con código 0 si coinciden o 1 si no, para uso en cron/monitoreo. El chequeo es por totales; la certeza número a número la da el full sync completo.

### Ejemplo
`python3 full_sync.py --check` imprime `CHECK OK: ABD (master)=N == PSX (slave)=N. Cuadran.` o `CHECK FALLO: ... (faltan X en PSX).`

### Impacto
Sistemas afectados: Base de datos ABD (MSSQL), Base de datos PSX (Oracle).

---

### Regla: Descarga por streaming y reuso de intermedios
**Descripción:** Ambas bases se descargan por streaming fila por fila directo a disco (sin cargar la tabla completa en memoria), ya que pueden tener decenas de millones de registros. El progreso se reporta por tiempo (`SYNC_PROGRESS_SECS`), no por cantidad de filas, con velocidad y tiempo transcurrido. `SKIP_ABD`/`SKIP_PSX` permiten saltar la descarga y reusar el CSV de una corrida previa (requiere `SYNC_KEEP_INTERMEDIATE=true`); si el CSV a reusar no existe, se aborta para no comparar contra una base ausente.

### Ejemplo
`SKIP_ABD=true SKIP_PSX=true python3 full_sync.py --no-execute` reusa `abd.csv`/`psx.csv` y arranca directo en el troceo y la comparación, sin volver a descargar.

### Impacto
Sistemas afectados: `full_sync.py`, directorio de trabajo (`SYNC_WORKDIR`).

---

## Módulo: Portabilidad (mtysajpsx01)

### Regla: Dos modos de ejecución — fecha (día a día) y snapshot
**Descripción:** `mtysajpsx01.py` ejecuta las diferencias contra el equipo en dos modos mutuamente excluyentes. Modo fecha (día a día): `--date` o `--date-from/--date-to`; nombra los CSV `<PREFIX>_<TYPE>_<fecha>.csv` y aplica el calendario (omite domingos y festivos de México). Modo snapshot: `--label` o sin argumento; nombra `<PREFIX>_<TYPE>[_<label>].csv` y NO aplica calendario (un snapshot no depende del día de ejecución). Es el modo que usa el full sync.

### Ejemplo
Día a día: `python3 mtysajpsx01.py --type PORTED --date-from 20260701 --date-to 20260717`. Snapshot: `python3 mtysajpsx01.py --type PORTED --label prueba`.

### Impacto
Sistemas afectados: `mtysajpsx01.py`, `full_sync.py`, Equipo SONUS/EMS.

---

### Regla: Resiliencia y abort ante servidor caído
**Descripción:** Cada parte se envía por scp y se ejecuta remotamente con reintentos (`SSH_RETRIES`). Si se agotan y `RECOVERY_ENABLED=true`, se ejecuta una acción correctiva (ej. reboot remoto), se espera `RECOVERY_WAIT` y se reintenta hasta `RECOVERY_MAX_CYCLES` ciclos. Si el equipo sigue caído tras la recuperación, en modo rango se abortan los días restantes (no tiene sentido seguir intentando/rebooteando). Un checkpoint por parte permite reanudar sin repetir lo ya completado.

### Ejemplo
Ante caída del equipo tras agotar reintentos y ciclos de recuperación, el proceso notifica por correo, marca el día como fallido y aborta los días no intentados del rango, conservando sus checkpoints.

### Impacto
Sistemas afectados: `mtysajpsx01.py`, Equipo SONUS/EMS, notificaciones por correo (SMTP).

---
