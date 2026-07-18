"""
full_sync.py - Comparacion de bases y generacion de diferencias (Portabilidad)

Descarga la BD de portabilidad del area de Sistemas (ABD, Microsoft SQL Server)
y la del equipo PSX (Oracle, tabla NUMBER_TRANSLATION_DATA), calcula las
diferencias bidireccionales y genera dos archivos en formato de comandos CLI,
listos para que mtysajpsx01.py los ejecute con su pipeline (chunks, reintentos,
recuperacion/reboot y checkpoint):

  <FILE_PREFIX>_PORTED_<fecha>.csv   -> altas  (en ABD y no en PSX)  -> comandos put
  <FILE_PREFIX>_DELETED_<fecha>.csv  -> bajas  (en PSX y no en ABD) -> comandos delete
(FILE_PREFIX se define en el .env; por defecto MTYSAJPSX01)

Ambas bases se descargan COMPLETAS (una consulta por base) y el loteo por
prefijo se aplica DESPUES, al procesar (split + comparar), para acotar la
memoria: comparar() carga solo un lote por lado a la vez. La profundidad del
loteo se controla con SYNC_DEPTH.

Toda la configuracion (servidores y credenciales de ambas BD, rutas) proviene
del .env. La comparacion siempre cubre TODA la numeracion (prefijos 2..9); el
loteo es solo para controlar memoria, no un subconjunto.
Este script SOLO genera los CSV; la ejecucion la realiza mtysajpsx01.py
(invocado, por ejemplo, desde run_abd.sh).

Uso:
    python3 full_sync.py --date YYYYMMDD
    python3 full_sync.py                     # usa la fecha de hoy
"""
import argparse
import os
import sys
from datetime import date

# ---------------------------------------------------------------------------
# Carga de variables desde .env (si esta disponible python-dotenv).
# ---------------------------------------------------------------------------
try:
  from dotenv import load_dotenv
  load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except ImportError:
  pass

import pandas as pd
import sqlalchemy as sal
import urllib.parse


# ---------------------------------------------------------------------------
# Configuracion desde .env
# ---------------------------------------------------------------------------
# BD Sistemas (ABD) - MSSQL
ABD_DRIVER = os.environ.get("ABD_DRIVER", "ODBC Driver 18 for SQL Server")
ABD_SERVER = os.environ.get("ABD_SERVER", "")
ABD_DATABASE = os.environ.get("ABD_DATABASE", "")
ABD_USER = os.environ.get("ABD_USER", "")
ABD_PASSWORD = os.environ.get("ABD_PASSWORD", "")
ABD_ENCRYPT = os.environ.get("ABD_ENCRYPT", "no")

# BD PSX - Oracle
PSX_HOST = os.environ.get("PSX_HOST", "")
PSX_PORT = os.environ.get("PSX_PORT", "1521")
PSX_SID = os.environ.get("PSX_SID", "")
PSX_USER = os.environ.get("PSX_USER", "")
PSX_PASSWORD = os.environ.get("PSX_PASSWORD", "")

# Rutas y parametros
FILE_PREFIX = os.environ.get("FILE_PREFIX", "MTYSAJPSX01")
DIRFILES = os.environ.get("DIRFILES", "/home/airflow/portabilidad")
SYNC_WORKDIR = os.environ.get("SYNC_WORKDIR", "").strip() or DIRFILES

# Digitos base del primer nivel de loteo (rango inicio-fin, inclusive), desde el
# .env. Cubren el universo de numeracion; por defecto 2..9.
# ADVERTENCIA: en un full sync el loteo base debe cubrir TODA la numeracion. Si
# se omite algun digito, los numeros de ese digito presentes en PSX y ausentes en
# ABD se detectarian como bajas y se borrarian indebidamente.
SYNC_BASE_FROM = int(os.environ.get("SYNC_BASE_FROM", "2"))
SYNC_BASE_TO = int(os.environ.get("SYNC_BASE_TO", "9"))
PREFIJOS_BASE = range(SYNC_BASE_FROM, SYNC_BASE_TO + 1)

# Profundidad del loteo: 1 => prefijos base; 2/3 => se anexan digitos 0..9.
SYNC_DEPTH = int(os.environ.get("SYNC_DEPTH", "1"))


def generar_prefijos(depth):
  """Genera la lista de prefijos de lote segun la profundidad.
    depth 1 -> ['2'..'9']            (8 lotes)
    depth 2 -> ['20'..'99']          (80 lotes)
    depth 3 -> ['200'..'999']        (800 lotes)
  El primer digito son los PREFIJOS_BASE (2..9); cada nivel extra agrega 0..9.
  Un loteo mas fino reduce las filas cargadas por lote (menos memoria en pandas).
  """
  if depth < 1:
    depth = 1
  prefijos = [str(b) for b in PREFIJOS_BASE]
  for _ in range(depth - 1):
    prefijos = [p + str(d) for p in prefijos for d in range(10)]
  return prefijos


def env_bool(name, default=False):
  return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "si", "y")


SYNC_KEEP_INTERMEDIATE = env_bool("SYNC_KEEP_INTERMEDIATE", False)
# Habilita el loteo al procesar. Si es False, se compara todo de una sola pasada.
SYNC_BATCH_ENABLED = env_bool("SYNC_BATCH_ENABLED", True)


# ---------------------------------------------------------------------------
# Conexiones a las bases de datos
# ---------------------------------------------------------------------------
def engine_abd():
  """Crea el engine SQLAlchemy hacia la BD de Sistemas (MSSQL) via pyodbc."""
  params = urllib.parse.quote_plus(
    "DRIVER={%s};"
    "SERVER=%s;"
    "DATABASE=%s;"
    "UID=%s;"
    "PWD=%s;"
    "Encrypt=%s" % (ABD_DRIVER, ABD_SERVER, ABD_DATABASE, ABD_USER, ABD_PASSWORD, ABD_ENCRYPT)
  )
  return sal.create_engine("mssql+pyodbc:///?odbc_connect={}".format(params))


def engine_psx():
  """Crea el engine SQLAlchemy hacia la BD del equipo PSX (Oracle).
  Usa python-oracledb (recomendado) o cx_Oracle como fallback."""
  try:
    import oracledb
    dsn = oracledb.makedsn(PSX_HOST, PSX_PORT, sid=PSX_SID)
    # Registra oracledb como reemplazo de cx_Oracle para el dialecto de SQLAlchemy.
    sys.modules.setdefault("cx_Oracle", oracledb)
  except ImportError:
    import cx_Oracle
    dsn = cx_Oracle.makedsn(PSX_HOST, PSX_PORT, sid=PSX_SID)

  cstr = "oracle://{user}:{password}@{dsn}".format(
    user=PSX_USER, password=PSX_PASSWORD, dsn=dsn
  )
  return sal.create_engine(cstr)


# ---------------------------------------------------------------------------
# Descarga de cada base
# ---------------------------------------------------------------------------
def descargar_abd():
  """Descarga COMPLETA de la BD ABD (MSSQL) a abd.csv (una sola consulta).
  Estructura: Number, Operador (sin header). El loteo se hace despues, al
  procesar (split_abd/comparar). Solo trae portaciones vigentes/futuras."""
  eng = engine_abd()
  print("[FULL_SYNC] Descargando BD ABD (Sistemas/MSSQL) desde %s ..." % ABD_SERVER)
  q = (
    "SELECT Number, CarrierRecipientId as Operador "
    "FROM [%s].[dbo].[Portability] (NOLOCK) "
    "WHERE FinalPortDate >= GETDATE()"
    % ABD_DATABASE
  )
  df = pd.read_sql_query(q, eng)
  df.to_csv(os.path.join(SYNC_WORKDIR, "abd.csv"), index=False, header=False)
  print("[FULL_SYNC]   ABD: %d registro(s)." % len(df))
  del df


def descargar_psx():
  """Descarga COMPLETA de la BD PSX (Oracle, NUMBER_TRANSLATION_DATA) a psx.csv
  (una sola consulta). Estructura: number, operator (3 primeros chars del
  TRANSLATED_NATIONAL_ID). El loteo se hace despues, al procesar."""
  eng = engine_psx()
  print("[FULL_SYNC] Descargando BD PSX (Oracle) desde %s:%s/%s ..."
        % (PSX_HOST, PSX_PORT, PSX_SID))

  psx_path = os.path.join(SYNC_WORKDIR, "psx.csv")
  fail_path = os.path.join(SYNC_WORKDIR, "psx_fail.csv")

  ok = 0
  fail = 0
  with eng.connect() as conn:
    result = conn.exec_driver_sql(
      "select NATIONAL_ID, TRANSLATED_NATIONAL_ID from NUMBER_TRANSLATION_DATA"
    )
    with open(psx_path, "w") as f, open(fail_path, "w") as t:
      for row in result:
        try:
          # operator = primeros 3 caracteres del TRANSLATED_NATIONAL_ID
          f.write("%s,%s\n" % (row[0], row[1][:3]))
          ok += 1
        except Exception:
          t.write("%s,\n" % (row,))
          fail += 1
  print("[FULL_SYNC]   PSX: %d registro(s) OK, %d con formato invalido." % (ok, fail))


def split_por_prefijo(base, prefijos):
  """Divide <base>.csv (abd/psx) en <base>_<pref>.csv por prefijo de numero.
  El prefijo es un string (ej. '2' o '20' o '200') segun SYNC_DEPTH. Ambas bases
  usan el mismo conjunto de prefijos para que los lotes casen al comparar.
  Aqui es donde se aplica realmente el loteo: la descarga trae todo, el split
  lo trocea para que comparar() cargue solo un lote a la vez."""
  ruta = os.path.join(SYNC_WORKDIR, f"{base}.csv")
  df = pd.read_csv(ruta, names=["number", "operator"], dtype={"number": str, "operator": str})
  for pref in prefijos:
    sub = df[df["number"].str.startswith(pref)]
    sub.to_csv(os.path.join(SYNC_WORKDIR, f"{base}_{pref}.csv"), header=False, index=False)
  print("[FULL_SYNC]   %s dividido en %d lote(s)." % (base.upper(), len(prefijos)))
  del df


# ---------------------------------------------------------------------------
# Comparacion y generacion de comandos CLI
# ---------------------------------------------------------------------------
def comando_put(num, operator):
  """Genera la linea de comando 'put' (alta) para el batch_script del equipo."""
  return (
    f'put Number_Translation National_Id {num} Country_Id 52 Attributes 0x0 '
    f'Call_Processing_Element1_Id "" Call_Processing_Element2_Id "" '
    f'Call_Processing_Element3_Id "" Call_Processing_Element4_Id "" '
    f'Call_Processing_Element_Type 0 Direct_Translation_Flag 0x2 '
    f'Translated_Country_Id 52 Translated_Carrier_Id "" Translated_Npi 1 '
    f'Translated_Noa 3 Translation_Label_Id 00_TL_dummy '
    f'Translated_National_Id {operator}177{num} \n'
  )


def comando_delete(num):
  """Genera la linea de comando 'delete' (baja) para el batch_script del equipo."""
  return (
    f'delete Number_Translation National_Id {num} Country_Id 52 Attributes 0x0 '
    f'Call_Processing_Element1_Id "" Call_Processing_Element2_Id "" '
    f'Call_Processing_Element3_Id "" Call_Processing_Element4_Id "" '
    f'Call_Processing_Element_Type 0\n'
  )


def _leer_lote(ruta):
  """Lee un CSV de lote (num, operator). Devuelve un DataFrame vacio (con las
  columnas esperadas) si el archivo no existe o esta vacio. Con loteo profundo
  (depth 2/3) muchos lotes no tienen datos, asi que esto es lo normal."""
  cols = ["num", "operator"]
  if not os.path.isfile(ruta) or os.path.getsize(ruta) == 0:
    return pd.DataFrame(columns=cols, dtype=str)
  try:
    return pd.read_csv(ruta, names=cols, dtype=str)
  except pd.errors.EmptyDataError:
    return pd.DataFrame(columns=cols, dtype=str)


def comparar(prefijos):
  """Compara ABD vs PSX por lote (prefijo) y devuelve (lineas_put, lineas_del).
  Solo se cargan en memoria los dos lotes del prefijo en curso, no las bases
  completas: por eso un loteo mas profundo (SYNC_DEPTH) reduce el pico de RAM.

  Referencia: el PSX es el estado actual del equipo.
    - En ABD y no en PSX -> alta   (put)     -> PORTED
    - En PSX y no en ABD -> baja   (delete)  -> DELETED
  """
  lineas_put = []
  lineas_del = []
  total_add = 0
  total_del = 0

  for pref in prefijos:
    df_psx = _leer_lote(os.path.join(SYNC_WORKDIR, f"psx_{pref}.csv"))
    df_abd = _leer_lote(os.path.join(SYNC_WORKDIR, f"abd_{pref}.csv"))

    # Lotes vacios en ambos lados: nada que comparar (comun con depth 2/3).
    if df_psx.empty and df_abd.empty:
      del df_psx, df_abd
      continue

    # Altas: filas de ABD que no estan en PSX (comparando la tupla completa).
    solo_abd = df_abd[~df_abd.apply(tuple, 1).isin(df_psx.apply(tuple, 1))]
    for row in solo_abd.itertuples(index=False, name="R"):
      lineas_put.append(comando_put(row.num, row.operator))
    total_add += len(solo_abd)

    # Bajas: filas de PSX que no estan en ABD.
    solo_psx = df_psx[~df_psx.apply(tuple, 1).isin(df_abd.apply(tuple, 1))]
    for row in solo_psx.itertuples(index=False, name="R"):
      lineas_del.append(comando_delete(row.num))
    total_del += len(solo_psx)

    if len(solo_abd) or len(solo_psx):
      print("[FULL_SYNC]   prefijo %s: %d alta(s), %d baja(s)."
            % (pref, len(solo_abd), len(solo_psx)))
    del df_psx, df_abd, solo_abd, solo_psx

  print("[FULL_SYNC] Diferencias totales: %d alta(s) (PORTED), %d baja(s) (DELETED)."
        % (total_add, total_del))
  return lineas_put, lineas_del


def escribir_salida(tipo, fecha, lineas):
  """Escribe el CSV consolidado que ejecutara mtysajpsx01.py.
  El header '?EMS::CLI?' NO se agrega aqui: mtysajpsx01.extract_lines lo antepone
  automaticamente a las partes 2..N. La parte 1 (sin header) es la convencion
  actual del pipeline."""
  destino = os.path.join(DIRFILES, f"{FILE_PREFIX}_{tipo}_{fecha}.csv")
  with open(destino, "w") as f:
    f.writelines(lineas)
  print("[FULL_SYNC] Generado %s (%d comando(s))." % (destino, len(lineas)))
  return destino


def limpiar_intermedios(prefijos):
  """Borra los archivos intermedios abd_*/psx_* si SYNC_KEEP_INTERMEDIATE=false."""
  if SYNC_KEEP_INTERMEDIATE:
    return
  patrones = ["abd.csv", "psx.csv", "psx_fail.csv"]
  for pref in prefijos:
    patrones += [f"abd_{pref}.csv", f"psx_{pref}.csv"]
  for p in patrones:
    ruta = os.path.join(SYNC_WORKDIR, p)
    try:
      if os.path.isfile(ruta):
        os.remove(ruta)
    except OSError:
      pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
  parser = argparse.ArgumentParser(description="Full sync: compara ABD vs PSX y genera diferencias")
  parser.add_argument("--date", type=str, help="Fecha para nombrar los CSV (YYYYMMDD). Default: hoy.")
  args = parser.parse_args()

  fecha = args.date if args.date else date.today().strftime("%Y%m%d")

  os.makedirs(SYNC_WORKDIR, exist_ok=True)
  os.makedirs(DIRFILES, exist_ok=True)

  # Prefijos de loteo. Con el loteo deshabilitado se usa un unico "lote" con
  # prefijo vacio (""), que incluye todos los numeros (startswith("") == True):
  # asi se compara todo de una sola pasada reutilizando la misma logica.
  # Los prefijos cubren SIEMPRE toda la numeracion (base 2..9); SYNC_DEPTH solo
  # controla que tan fino es el loteo para reducir memoria, no un subconjunto.
  if SYNC_BATCH_ENABLED:
    prefijos = generar_prefijos(SYNC_DEPTH)
    print("[FULL_SYNC] Loteo HABILITADO (depth=%d => %d lote(s))."
          % (SYNC_DEPTH, len(prefijos)))
  else:
    prefijos = [""]
    print("[FULL_SYNC] Loteo DESHABILITADO: comparacion en una sola pasada.")

  # 1) Descarga COMPLETA de ambas bases (una consulta por base).
  descargar_abd()
  descargar_psx()

  # 2) Troceo por prefijo (si el loteo esta activo) y comparacion. comparar()
  #    carga solo un lote por lado a la vez (control de memoria).
  split_por_prefijo("abd", prefijos)
  split_por_prefijo("psx", prefijos)
  lineas_put, lineas_del = comparar(prefijos)

  escribir_salida("PORTED", fecha, lineas_put)
  escribir_salida("DELETED", fecha, lineas_del)

  limpiar_intermedios(prefijos)
  print("[FULL_SYNC] Listo. Ejecuta las diferencias con mtysajpsx01.py "
        "(--type PORTED / --type DELETED --date %s)." % fecha)


if __name__ == "__main__":
  main()
