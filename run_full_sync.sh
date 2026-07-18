#!/bin/bash
# ===========================================================================
# run_full_sync.sh - Orquesta el FULL SYNC de portabilidad
# ---------------------------------------------------------------------------
# 1) full_sync.py compara la BD de Sistemas (ABD/MSSQL) con la del equipo PSX
#    (Oracle) y GENERA los diffs en DIRFILES:
#       MTYSAJPSX01_PORTED_<fecha>.csv   (altas)
#       MTYSAJPSX01_DELETED_<fecha>.csv  (bajas)
# 2) mtysajpsx01.py EJECUTA esas diferencias contra el equipo, con todo el
#    pipeline: chunks, reintentos, accion correctiva (reboot) y checkpoint.
#
# Toda la configuracion (servidores, credenciales, rutas) esta en .env.
#
# Uso:
#   ./run_full_sync.sh [YYYYMMDD]
#   (sin argumento usa la fecha de hoy)
# ===========================================================================
set -euo pipefail

# Directorio del script (para ubicar full_sync.py / mtysajpsx01.py / .env)
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Fecha: argumento o la de hoy
date_ini="${1:-$(date +'%Y%m%d')}"

echo "[RUN] Full sync para la fecha ${date_ini}"

# --- 1) Generar diferencias (ABD vs PSX) ---
echo "[RUN] Generando diferencias con full_sync.py ..."
python3 "${BASE_DIR}/full_sync.py" --date "${date_ini}"

# --- 2) Ejecutar las diferencias con el pipeline (validaciones/reintentos/reboot) ---
# Se ejecutan por separado PORTED (altas) y DELETED (bajas). Cada uno hereda
# toda la logica de resiliencia de mtysajpsx01.py.
echo "[RUN] Ejecutando ALTAS (PORTED) ..."
python3 "${BASE_DIR}/mtysajpsx01.py" --type PORTED --date "${date_ini}"

echo "[RUN] Ejecutando BAJAS (DELETED) ..."
python3 "${BASE_DIR}/mtysajpsx01.py" --type DELETED --date "${date_ini}"

echo "[RUN] Full sync ${date_ini} finalizado."
