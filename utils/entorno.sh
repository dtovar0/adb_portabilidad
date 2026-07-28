#!/usr/bin/env bash
#
# Entorno comun para los wrappers de cron (run_diario.sh, run_full_sync.sh).
# No se ejecuta solo: se incluye con '. entorno.sh'.
#
# Define:
#   PYTHON       -> el interprete a usar (el del venv si existe)
#   PATH         -> completo, para que ssh/scp/flock se encuentren bajo cron
#   VIRTUAL_ENV  -> por si el proceso lanza subcomandos que esperan el venv
#
# Espera que quien lo incluya haya definido REPO (raiz del repo).
#
# El venv se busca en este orden:
#   1) $VENV_DIR    (exportado al invocar, o definido en el crontab)
#   2) <repo>/venv  (el que ignora .gitignore)
#   3) <repo>/.venv
#   4) $HOME/venv
# Si no hay ninguno, se usa python3 del sistema y se avisa por stderr.

# PATH explicito: el de cron suele ser solo /usr/bin:/bin y puede faltar
# /usr/local/bin (donde viven ssh/scp en algunas instalaciones).
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Salida sin buffer: con buffer, si el proceso muere a media corrida el log se
# queda a medias y no se ve donde fallo.
export PYTHONUNBUFFERED=1

PYTHON=""
for _cand in \
    "${VENV_DIR:-}" \
    "${REPO:-}/venv" \
    "${REPO:-}/.venv" \
    "${HOME:-}/venv"; do
  if [ -n "$_cand" ] && [ -x "$_cand/bin/python" ]; then
    PYTHON="$_cand/bin/python"
    # No se hace 'source activate': invocar el python del venv por ruta absoluta
    # es equivalente (el interprete resuelve su propio sys.path) y evita que el
    # activate choque con 'set -u'.
    export VIRTUAL_ENV="$_cand"
    export PATH="$_cand/bin:$PATH"
    break
  fi
done
unset _cand

if [ -z "$PYTHON" ]; then
  echo "[entorno] AVISO: no se encontro el venv (probe VENV_DIR, ${REPO:-?}/venv," \
       "${REPO:-?}/.venv, ${HOME:-?}/venv). Usando python3 del sistema, que puede" \
       "no tener los drivers de BD instalados." >&2
  PYTHON="$(command -v python3)"
fi
