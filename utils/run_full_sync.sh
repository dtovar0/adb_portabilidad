#!/usr/bin/env bash
#
# Wrapper para correr el FULL SYNC (full_sync.py) desde cron.
#
# Equivale a:  python full_sync.py
#
# A diferencia del diario, el full sync NO maneja fechas: siempre es un snapshot
# del estado total (compara ABD contra PSX completos).
#
# Cron NO es un shell de login: PATH minimo, sin las variables del perfil, cwd en
# $HOME y SIN el venv activado. Este script resuelve todo eso.
#
# El .env NO se carga aqui: full_sync.py lo lee por ruta absoluta derivada de su
# propia ubicacion, asi que funciona sin importar el cwd.
#
# Uso:
#   ./run_full_sync.sh                  # genera y ejecuta
#   ./run_full_sync.sh --no-execute     # solo genera los CSV, no toca el equipo
#   ./run_full_sync.sh --check          # solo compara conteos ABD vs PSX (sale 1 si no cuadran)
#   ./run_full_sync.sh --label 20260727 # etiqueta en el nombre de los CSV

set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$AQUI")"

# shellcheck source=entorno.sh
. "$AQUI/entorno.sh"

# Un solo proceso a la vez: el full sync dura mucho (descarga de ambas BD +
# comparacion + ejecucion por partes con pausas). Si el cron vuelve a disparar
# antes de que termine el anterior, dos corridas pelearian por los mismos CSV, el
# checkpoint y la sesion CLI del equipo.
#
# Cerrojo distinto al del diario: son procesos distintos y no deben bloquearse
# entre si por accidente. (Si NO quieres que se solapen entre ellos, usa el mismo
# archivo de cerrojo en los dos.)
CERROJO="${CERROJO:-/tmp/portabilidad_full_sync.lock}"

exec flock -n "$CERROJO" \
  "$PYTHON" "$REPO/utils/full_sync.py" "$@"
