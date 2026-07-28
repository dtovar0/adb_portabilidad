#!/usr/bin/env bash
#
# Wrapper para correr la portabilidad DIARIA (mtysajpsx01.py) desde cron.
#
# Equivale a:  python mtysajpsx01.py --date YYYYMMDD
#
# La fecha por defecto es AYER, no hoy: el CSV de un dia se genera al dia
# siguiente, y mtysajpsx01.py rechaza cualquier fecha >= hoy ("el proceso va un
# dia atras"). Una linea de cron con fecha fija solo serviria un dia; con
# 'date -d yesterday' sirve siempre.
#
# Cron NO es un shell de login: PATH minimo, sin las variables del perfil, cwd en
# $HOME y SIN el venv activado. Este script resuelve todo eso.
#
# El .env NO se carga aqui: mtysajpsx01.py lo lee por ruta absoluta derivada de su
# propia ubicacion, asi que funciona sin importar el cwd.
#
# Uso:
#   ./run_diario.sh                        # ayer, PORTED y DELETED (BOTH)
#   ./run_diario.sh --date 20260727        # una fecha concreta
#   ./run_diario.sh --type PORTED          # solo altas, de ayer
#   ./run_diario.sh --date-from 20260701 --date-to 20260727   # un rango
#
# Cualquier argumento que pases se reenvia tal cual al script. Si NO pasas
# ninguna fecha (--date / --date-from), se agrega --date <ayer>.

set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$AQUI")"

# shellcheck source=entorno.sh
. "$AQUI/entorno.sh"

# Fecha por defecto: ayer. Solo se agrega si el usuario no especifico ninguna,
# para no pisar un --date/--date-from explicito.
ARGS=("$@")
tiene_fecha=false
for a in "$@"; do
  case "$a" in
    --date|--date=*|--date-from|--date-from=*) tiene_fecha=true ;;
  esac
done
if [ "$tiene_fecha" = false ]; then
  ARGS+=(--date "$(date -d yesterday +%Y%m%d)")
fi

# Un solo proceso a la vez: el diario tarda (partes de CHUNK_SIZE con pausas
# SLEEP_BETWEEN y reintentos). Dos corridas solapadas pelearian por los mismos
# CSV, el checkpoint y la sesion CLI del equipo.
CERROJO="${CERROJO:-/tmp/portabilidad_diario.lock}"

exec flock -n "$CERROJO" \
  "$PYTHON" "$REPO/utils/mtysajpsx01.py" "${ARGS[@]}"
