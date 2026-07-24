import pexpect, argparse, sys, os
import re
import time
import smtplib
import socket
from datetime import date, datetime, timedelta
from email.mime.text import MIMEText

# ---------------------------------------------------------------------------
# Carga de variables desde .env (si esta disponible python-dotenv).
# Si no esta instalado, se usan las variables de entorno ya exportadas.
# ---------------------------------------------------------------------------
try:
  from dotenv import load_dotenv
  # El .env vive en la raiz del repo (un nivel arriba de utils/), compartido con backend/.
  load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
except ImportError:
  pass


def env_bool(name, default=False):
  return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "si", "y")


class ServidorCaidoError(Exception):
  """Se lanza cuando una parte agota reintentos Y los ciclos de recuperacion
  (reboot). Indica que el equipo remoto sigue mal: en modo rango, esto debe
  abortar los dias restantes en lugar de seguir intentando (y rebooteando)."""
  pass


class OrigenCaidoError(Exception):
  """Se lanza cuando el servidor de ORIGEN (SOURCE_HOST) no responde al ping
  tras agotar el sondeo. Distingue 'servidor de origen caido' de 'archivo aun no
  generado': en el pre-chequeo del rango, aborta todo (no tiene sentido buscar
  los CSV de los demas dias si el origen no responde)."""
  pass


class ArchivoOrigenFaltanteError(Exception):
  """Se lanza cuando el servidor de origen SI responde al ping pero el CSV del
  dia no existe/no se pudo descargar. Es un fallo por dato faltante, no por
  servidor caido."""
  pass


# ---------------------------------------------------------------------------
# Configuracion de notificaciones
# ---------------------------------------------------------------------------
NOTIFY_START = env_bool("NOTIFY_START", True)
NOTIFY_END = env_bool("NOTIFY_END", True)
NOTIFY_ERROR = env_bool("NOTIFY_ERROR", True)

SMTP_HOST = os.environ.get("SMTP_HOST", "localhost")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "25"))
SMTP_USER = os.environ.get("SMTP_USER", "").strip()
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "").strip()
SMTP_TLS = env_bool("SMTP_TLS", False)
MAIL_FROM = os.environ.get("MAIL_FROM", "")
MAIL_TO = [x.strip() for x in os.environ.get("MAIL_TO", "").split(",") if x.strip()]

# ---------------------------------------------------------------------------
# Configuracion de conexion
# ---------------------------------------------------------------------------
# Hay TRES conexiones independientes, cada una a su propio servidor:
#   1) EMS_CLI : sesion pexpect que ejecuta los comandos put/delete (SSH_*/CLI_*)
#   2) SCP     : copia de los archivos de comandos al servidor destino (SCP_*)
#   3) RECOVERY: accion correctiva/reboot tras agotar reintentos (RECOVERY_SSH_*)
# No comparten host/puerto/usuario: cada bloque define los suyos.

# --- 1) EMS_CLI (sesion pexpect a la consola SONUS/EMS) ---
SSH_HOST = os.environ.get("SSH_HOST", "")
# Puerto de la SESION CLI del EMS (ssh interactivo a la consola SONUS/EMS). En
# estos equipos suele ser un puerto propio de la CLI (p. ej. 8122), distinto del
# SSH estandar del sistema operativo por el que viaja el scp de archivos.
SSH_PORT = os.environ.get("SSH_PORT", "")
SSH_USER = os.environ.get("SSH_USER", "")
CLI_PASSWORD = os.environ.get("CLI_PASSWORD", "")
CLI_INSTANCE = os.environ.get("CLI_INSTANCE", "")
FILE_PREFIX = os.environ.get("FILE_PREFIX", "")

# --- 2) SCP (copia de archivos; puede ir a OTRO servidor que la CLI) ---
# Host destino del scp. Es una conexion aparte de la CLI, por eso tiene su propio
# host. Si se deja vacio, cae a SSH_HOST (retrocompatible con el caso de un solo
# servidor donde la CLI y el scp coinciden).
SCP_HOST = os.environ.get("SCP_HOST", "").strip() or SSH_HOST
SCP_USER = os.environ.get("SCP_USER", "")
# Puerto del scp de los archivos. Es el SSH del SISTEMA OPERATIVO (por defecto 22),
# NO el de la CLI: el scp copia archivos al filesystem del equipo, no entra a la
# consola CLI. Se separa de SSH_PORT porque en el EMS son puertos distintos.
SCP_PORT = os.environ.get("SCP_PORT", "22")
SCP_DEST_PATH = os.environ.get("SCP_DEST_PATH", "")

# --- 4) SOURCE (pull del CSV diario de origen desde otro servidor) ---
# En modo fecha (portabilidad diaria/rango), el CSV <PREFIX>_<TYPE>_<fecha>.csv
# lo produce un tercer servidor (p. ej. 172.21.0.13). Si SOURCE_HOST esta
# definido y el CSV no esta en DIRFILES, se baja por scp desde ahi antes de
# trocearlo. Si SOURCE_HOST esta vacio, se conserva el comportamiento previo:
# el archivo debe existir ya localmente. Solo aplica al modo fecha; el snapshot
# de full_sync lo genera full_sync.py y no se descarga.
SOURCE_HOST = os.environ.get("SOURCE_HOST", "").strip()
SOURCE_USER = os.environ.get("SOURCE_USER", "").strip()
SOURCE_PORT = os.environ.get("SOURCE_PORT", "22").strip()
# Directorio remoto donde vive el CSV en el servidor de origen. El nombre del
# archivo (<PREFIX>_<TYPE>_<fecha>.csv) se agrega al final.
SOURCE_PATH = os.environ.get("SOURCE_PATH", "").strip()

# --- Ping al servidor de origen (diagnostico cuando falla la descarga) ---
# Si la descarga por scp falla o el archivo no aparece, se hace ping a SOURCE_HOST
# para distinguir dos causas: si NO responde -> el servidor de origen esta caido
# (alarma distinta); si responde -> el archivo no existe (aun no se genero).
# El sondeo son SOURCE_PING_TRIES pruebas, una por SOURCE_PING_INTERVAL segundos,
# cada una enviando SOURCE_PING_COUNT paquetes. Por defecto: 5 pruebas x 1 min x
# 5 paquetes (~5 min de espera total antes de declarar el servidor caido).
SOURCE_PING_COUNT = int(os.environ.get("SOURCE_PING_COUNT", "5"))
SOURCE_PING_TRIES = int(os.environ.get("SOURCE_PING_TRIES", "5"))
SOURCE_PING_INTERVAL = int(os.environ.get("SOURCE_PING_INTERVAL", "60"))

# Modo debug de la sesion CLI (pexpect) y del scp. Con true:
#   - duplica TODA la salida del pexpect a la pantalla (ademas del archivo de log
#     LOG_DIR/<parte>.csv, que se conserva),
#   - imprime el comando ssh que se lanza, los comandos que se envian a la CLI y
#     el comando scp completo.
# Se activa con CLI_DEBUG=true o, para reutilizar el mismo switch del full_sync,
# con SYNC_DEBUG=true. Por defecto false (salida solo al archivo de log).
CLI_DEBUG = env_bool("CLI_DEBUG", False) or env_bool("SYNC_DEBUG", False)

# Lineas de ruido benigno del transporte ssh (no de la CLI) que contienen
# palabras como 'failed' y provocarian un falso positivo en la deteccion de
# errores de la salida de la CLI. Se comparan en minusculas contra cada linea.
# El caso tipico es 'PTY allocation request failed on channel 0' del banner de
# login cuando el equipo no asigna un pseudo-terminal (ya se evita con 'ssh -T').
RUIDO_SSH_BENIGNO = (
  "pty allocation request failed",
)

# ---------------------------------------------------------------------------
# Rutas y parametros del proceso
# ---------------------------------------------------------------------------
DIRFILES = os.environ.get("DIRFILES", "")
LOG_DIR = os.environ.get("LOG_DIR", "")
# Con true (default) se crean al arrancar los directorios de trabajo (DIRFILES,
# LOG_DIR, CHECKPOINT_DIR) si no existen, para no fallar por un directorio
# inexistente. Con false se exige que ya existan (falla si falta alguno).
CREATE_DIRS = env_bool("CREATE_DIRS", True)
CHUNK_SIZE = int(os.environ.get("CHUNK_SIZE", "20000"))
# Tolerancia (en lineas) permitida entre los 'Result: Ok' del log y las lineas
# esperadas del archivo en validar_batch(). El EMS puede no volcar al log el
# 'Result: Ok' final del propio 'execute batch_script' antes de que el 'exit'
# corte la conexion (EOF), quedando obtenidos = esperados - 1 aunque el batch
# haya corrido completo. Con VALIDATE_TOLERANCE>=1 esa diferencia no marca fallo
# (se apoya en la comprobacion del ultimo comando ejecutado para garantizar que
# el batch llego al final). Default 1.
VALIDATE_TOLERANCE = int(os.environ.get("VALIDATE_TOLERANCE", "1"))
SLEEP_BETWEEN = int(os.environ.get("SLEEP_BETWEEN", "120"))
# Tiempo maximo (segundos) que la sesion CLI espera el prompt del EMS. Cubre
# sobre todo el 'execute batch_script', donde el EMS procesa los CHUNK_SIZE
# comandos put/delete. Si una parte tarda mas que esto, pexpect corta con TIMEOUT
# y la marca como fallida aunque el EMS siga trabajando: subirlo si el equipo es
# lento o bajar CHUNK_SIZE. Default 2400s (40 min).
CLI_TIMEOUT = int(os.environ.get("CLI_TIMEOUT", "2400"))

# ---------------------------------------------------------------------------
# Reintentos y reanudacion (checkpoint)
# ---------------------------------------------------------------------------
SSH_RETRIES = int(os.environ.get("SSH_RETRIES", "3"))
RETRY_SLEEP = int(os.environ.get("RETRY_SLEEP", "30"))
CHECKPOINT_DIR = os.environ.get("CHECKPOINT_DIR", "").strip() or LOG_DIR

# ---------------------------------------------------------------------------
# Accion correctiva (ej. reboot de equipo remoto) tras agotar los reintentos
# ---------------------------------------------------------------------------
RECOVERY_ENABLED = env_bool("RECOVERY_ENABLED", False)
RECOVERY_SSH_HOST = os.environ.get("RECOVERY_SSH_HOST", "").strip()
RECOVERY_SSH_PORT = os.environ.get("RECOVERY_SSH_PORT", "").strip()
RECOVERY_SSH_USER = os.environ.get("RECOVERY_SSH_USER", "").strip()
RECOVERY_CMD = os.environ.get("RECOVERY_CMD", "").strip()
RECOVERY_WAIT = int(os.environ.get("RECOVERY_WAIT", "180"))
RECOVERY_MAX_CYCLES = int(os.environ.get("RECOVERY_MAX_CYCLES", "1"))
RECOVERY_TIMEOUT = int(os.environ.get("RECOVERY_TIMEOUT", "60"))

# ---------------------------------------------------------------------------
# Calendario: omitir domingos y festivos
# ---------------------------------------------------------------------------
SKIP_SUNDAY = env_bool("SKIP_SUNDAY", True)
SKIP_HOLIDAYS = env_bool("SKIP_HOLIDAYS", True)
EXTRA_HOLIDAYS = [x.strip() for x in os.environ.get("EXTRA_HOLIDAYS", "").split(",") if x.strip()]
# Por defecto 'data': el calendario se evalua contra la FECHA DE CADA DATO, no
# la de ejecucion. Asi, al procesar un rango (--date-from/--date-to), se omiten
# los domingos/festivos historicos del propio rango, no solo si HOY lo es. Pon
# 'run' para volver a evaluar la fecha de ejecucion.
SKIP_CHECK_DATE = os.environ.get("SKIP_CHECK_DATE", "data").strip().lower()


# ---------------------------------------------------------------------------
# Validacion de configuracion obligatoria
# ---------------------------------------------------------------------------
def validar_configuracion():
  """Verifica que las variables obligatorias esten definidas en el entorno/.env.
  Aborta con un mensaje claro si falta alguna, en lugar de fallar de forma
  confusa mas adelante (ssh a un host vacio, archivos con prefijo vacio, etc.)."""
  requeridas = {
    "SSH_HOST": SSH_HOST,
    "SSH_PORT": SSH_PORT,
    "SSH_USER": SSH_USER,
    "CLI_PASSWORD": CLI_PASSWORD,
    "CLI_INSTANCE": CLI_INSTANCE,
    "FILE_PREFIX": FILE_PREFIX,
    "SCP_USER": SCP_USER,
    "SCP_PORT": SCP_PORT,
    "SCP_DEST_PATH": SCP_DEST_PATH,
    "DIRFILES": DIRFILES,
    "LOG_DIR": LOG_DIR,
  }
  faltantes = [nombre for nombre, valor in requeridas.items() if not str(valor).strip()]

  # Si las notificaciones estan activas, tambien se requiere el correo.
  if NOTIFY_START or NOTIFY_END or NOTIFY_ERROR:
    if not MAIL_FROM.strip():
      faltantes.append("MAIL_FROM")
    if not MAIL_TO:
      faltantes.append("MAIL_TO")

  # Si la recuperacion esta activa, se requieren sus parametros.
  if RECOVERY_ENABLED:
    for nombre, valor in {
      "RECOVERY_SSH_HOST": RECOVERY_SSH_HOST,
      "RECOVERY_SSH_PORT": RECOVERY_SSH_PORT,
      "RECOVERY_SSH_USER": RECOVERY_SSH_USER,
      "RECOVERY_CMD": RECOVERY_CMD,
    }.items():
      if not str(valor).strip():
        faltantes.append(nombre)

  if faltantes:
    print("[ERROR] Faltan variables obligatorias en el .env: %s"
          % ", ".join(faltantes), file=sys.stderr)
    print("[ERROR] Define esas variables en %s"
          % os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
          file=sys.stderr)
    sys.exit(2)

  asegurar_directorios()


def asegurar_directorios():
  """Prepara los directorios de trabajo (DIRFILES, LOG_DIR, CHECKPOINT_DIR).
  Con CREATE_DIRS=true (default) crea los que falten para no fallar por un
  directorio inexistente. Con CREATE_DIRS=false solo verifica que existan y aborta
  si falta alguno. Los duplicados (p. ej. CHECKPOINT_DIR heredando LOG_DIR) se
  resuelven solos por el set."""
  directorios = {d for d in (DIRFILES, LOG_DIR, CHECKPOINT_DIR) if str(d).strip()}
  for d in sorted(directorios):
    if os.path.isdir(d):
      continue
    if CREATE_DIRS:
      try:
        os.makedirs(d, exist_ok=True)
        print("[DIRS] Directorio creado: %s" % d)
      except OSError as e:
        print("[ERROR] No se pudo crear el directorio '%s': %s" % (d, e), file=sys.stderr)
        sys.exit(2)
    else:
      print("[ERROR] El directorio '%s' no existe y CREATE_DIRS=false." % d, file=sys.stderr)
      sys.exit(2)


def send_notification(kind, subject, body):
  """Envia una notificacion por correo segun el toggle correspondiente.
  kind: 'start' | 'end' | 'error'. No aborta el proceso si falla el envio."""
  enabled = {"start": NOTIFY_START, "end": NOTIFY_END, "error": NOTIFY_ERROR}.get(kind, True)
  if not enabled:
    print("[NOTIFICACION] Deshabilitada (%s): %s" % (kind, subject))
    return
  try:
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = MAIL_FROM
    msg["To"] = ", ".join(MAIL_TO)

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as server:
      if SMTP_TLS:
        server.starttls()
      if SMTP_USER:
        server.login(SMTP_USER, SMTP_PASSWORD)
      server.sendmail(MAIL_FROM, MAIL_TO, msg.as_string())
    print("[NOTIFICACION] Enviada: %s" % subject)
  except Exception as e:
    print("[NOTIFICACION] Error al enviar '%s': %s" % (subject, e), file=sys.stderr)


def causa_timeout_cli(exc):
  """Recorre la cadena de excepciones (la propia y sus __cause__/__context__)
  buscando un TimeoutError, que es como EXPECT() marca el corte por CLI_TIMEOUT.
  ejecutar_parte() envuelve ese TimeoutError en un RuntimeError/ServidorCaidoError,
  asi que aqui se desanida para reconocer el motivo real. Devuelve el TimeoutError
  encontrado (para reutilizar su mensaje) o None."""
  visto = set()
  e = exc
  while e is not None and id(e) not in visto:
    visto.add(id(e))
    if isinstance(e, TimeoutError):
      return e
    e = e.__cause__ or e.__context__
  return None


def parse_run_date(date_str):
  """Interpreta la fecha de --date. Acepta 'YYYYMMDD' o 'YYYY-MM-DD'.
  Devuelve un objeto date, o None si no se puede interpretar."""
  for fmt in ("%Y%m%d", "%Y-%m-%d"):
    try:
      return datetime.strptime(date_str, fmt).date()
    except ValueError:
      continue
  return None


def dia_omitido(fecha):
  """Determina si 'fecha' (objeto date) debe omitirse por domingo o festivo.
  Devuelve (True, motivo) si se debe omitir, o (False, None) en caso contrario."""
  if SKIP_SUNDAY and fecha.weekday() == 6:  # 6 = domingo
    return True, "domingo (%s)" % fecha.isoformat()

  if SKIP_HOLIDAYS:
    # Festivos extra definidos manualmente en el .env
    if fecha.isoformat() in EXTRA_HOLIDAYS:
      return True, "festivo definido en EXTRA_HOLIDAYS (%s)" % fecha.isoformat()
    # Festivos oficiales de Mexico via libreria 'holidays' (si esta disponible)
    try:
      import holidays
      mx = holidays.Mexico(years=fecha.year)
      if fecha in mx:
        return True, "festivo de Mexico: %s (%s)" % (mx.get(fecha), fecha.isoformat())
    except ImportError:
      print("[AVISO] La libreria 'holidays' no esta instalada; "
            "solo se validan EXTRA_HOLIDAYS. (pip install holidays)", file=sys.stderr)

  return False, None


def nombre_base(tipo, ident):
  """Base del nombre de archivo para este tipo/identificador.
  El 'ident' es la fecha (modo dia a dia) o la etiqueta (modo snapshot); si esta
  vacio se omite para no dejar un guion bajo colgante:
    con ident  -> <PREFIX>_<TYPE>_<ident>
    sin ident  -> <PREFIX>_<TYPE>
  """
  ident = "" if ident is None else str(ident).strip()
  if ident:
    return "%s_%s_%s" % (FILE_PREFIX, tipo, ident)
  return "%s_%s" % (FILE_PREFIX, tipo)


def checkpoint_path(tipo, fecha):
  """Ruta del archivo de checkpoint para este tipo/identificador."""
  return "%s/.checkpoint_%s" % (CHECKPOINT_DIR, nombre_base(tipo, fecha))


def leer_checkpoint(tipo, fecha):
  """Devuelve el conjunto de numeros de parte ya completadas segun el checkpoint."""
  ruta = checkpoint_path(tipo, fecha)
  hechas = set()
  if os.path.isfile(ruta):
    with open(ruta, "r") as f:
      for linea in f:
        linea = linea.strip()
        if linea.isdigit():
          hechas.add(int(linea))
  return hechas


def marcar_parte_completada(tipo, fecha, parte):
  """Registra (append + flush) que una parte se completo, para poder reanudar.
  Si el checkpoint no se puede escribir (dir inexistente/sin permisos) se lanza
  excepcion en vez de perderlo en silencio: sin checkpoint no hay reanudacion y el
  proceso reiniciaria desde el principio, justo lo que se quiere evitar."""
  ruta = checkpoint_path(tipo, fecha)
  try:
    os.makedirs(CHECKPOINT_DIR, exist_ok=True)
    with open(ruta, "a") as f:
      f.write("%d\n" % parte)
      f.flush()
      os.fsync(f.fileno())
  except OSError as e:
    raise RuntimeError(
      "No se pudo escribir el checkpoint '%s' (parte %d): %s. Sin checkpoint no "
      "hay reanudacion; revisa CHECKPOINT_DIR/LOG_DIR y sus permisos."
      % (ruta, parte, e)
    )


def borrar_checkpoint(tipo, fecha):
  """Elimina el checkpoint al terminar todo el proceso correctamente."""
  ruta = checkpoint_path(tipo, fecha)
  try:
    if os.path.isfile(ruta):
      os.remove(ruta)
  except OSError:
    pass


def extract_lines(input_file, output_file, start_line, end_line):
  with open(input_file, 'r') as infile:
    lines = infile.readlines()

  with open(output_file, 'w') as outfile:
    # El header '?EMS::CLI?' va en la PRIMERA linea de TODAS las partes: el equipo
    # valida que el batch_script empiece con este marcador y, si falta, rechaza el
    # archivo con "The input script file is NOT a valid EMS::CLI script! @[line: 1,
    # command#: 0]". (Se habia quitado por error en 8298e38; el equipo lo exige.)
    outfile.write("?EMS::CLI?\n")

    for i in range(start_line, end_line):
      if 0 <= i < len(lines):
        outfile.write(lines[i])


def validar_batch(nombre_parte):
  """Valida que el EMS ejecuto TODOS los comandos del batch, leyendo el logfile
  ya cerrado en disco (LOG_DIR/<parte>.csv) en vez de mantenerlo en memoria.

  Hace DOS comprobaciones sobre el log:
    1) Cuenta los 'Result: Ok' del log y los compara contra el TOTAL de lineas del
       archivo de la parte CONTANDO el header '?EMS::CLI?'. El log trae un
       'Result: Ok' de mas (el que emite el propio 'execute batch_script' al
       terminar, ademas del de cada put/delete); ese +1 se compensa contando el
       header en los esperados, asi ambos lados quedan iguales. El conteo se hace
       contra las lineas del propio archivo de la parte, NO contra un fijo de
       CHUNK_SIZE: el ultimo chunk suele tener menos de CHUNK_SIZE lineas y
       compararlo contra 20k lo marcaria mal siempre.
    2) Confirma que el ULTIMO comando ejecutado por el EMS ('Executing: <cmd>' en
       el log) sea exactamente el ULTIMO comando del batch. Asi se asegura que el
       EMS llego hasta el final real y no solo que hubo N oks sueltos.
  Si algo no cuadra (corte por timeout/desconexion, ultimo comando distinto) lanza
  RuntimeError con el detalle."""
  batch = "%s/%s.csv" % (DIRFILES, nombre_parte)
  log = "%s/%s.csv" % (LOG_DIR, nombre_parte)

  # Lineas no vacias del archivo de la parte (header + comandos). Se ignoran
  # lineas en blanco por si el archivo termina en salto final.
  with open(batch, "r") as f:
    lineas = [ln.strip() for ln in f if ln.strip()]
  # esperados = TODAS las lineas CONTANDO el header: el header no genera comando,
  # pero su +1 compensa el 'Result: Ok' extra del 'execute batch_script'.
  esperados = len(lineas)
  # Para comparar el ultimo comando si se necesita el ultimo comando REAL, sin el
  # header (el header solo va al inicio, nunca al final).
  ultimo_batch = lineas[-1] if lineas else ""

  # Recorre el log una sola vez: cuenta los 'Result: Ok' (incluye el +1 del
  # execute batch_script) y captura el ultimo comando ejecutado ('Executing:').
  patron_ok = re.compile(r"result:\s*ok", re.IGNORECASE)
  patron_exec = re.compile(r"executing:\s*(.+?)\s*$", re.IGNORECASE)
  obtenidos = 0
  ultimo_log = None
  with open(log, "r", errors="ignore") as f:
    for ln in f:
      if patron_ok.search(ln):
        obtenidos += 1
      m = patron_exec.search(ln)
      if m:
        ultimo_log = m.group(1).strip()

  # 1) La cuenta de 'Result: Ok' (con el +1 del execute) debe coincidir con las
  # lineas del archivo (con el +1 del header). Se tolera SOLO que FALTEN hasta
  # VALIDATE_TOLERANCE 'Result: Ok' (obtenidos < esperados): el caso tipico es que
  # el EMS no alcance a volcar al log el 'Result: Ok' del propio 'execute
  # batch_script' antes de cortar la conexion tras el 'exit'; el batch corrio
  # completo (lo confirma la comprobacion #2). Que SOBREN 'Result: Ok'
  # (obtenidos > esperados) nunca se tolera: es una anomalia, no un corte.
  faltantes = esperados - obtenidos
  if faltantes < 0 or faltantes > VALIDATE_TOLERANCE:
    raise RuntimeError(
      "Batch incompleto en %s: %d 'Result: Ok' vs %d lineas del archivo "
      "(header incluido). El EMS no ejecuto todos los comandos (posible corte "
      "antes del final)." % (nombre_parte, obtenidos, esperados)
    )

  # 2) El ultimo comando ejecutado debe ser el ultimo comando del batch.
  if ultimo_log is None:
    raise RuntimeError(
      "No se encontro ninguna linea 'Executing:' en el log de %s; no se puede "
      "confirmar que el batch llego al final." % nombre_parte
    )
  if ultimo_log != ultimo_batch:
    raise RuntimeError(
      "El ultimo comando ejecutado en %s no coincide con el final del batch.\n"
      "  esperado: %s\n  en log:   %s" % (nombre_parte, ultimo_batch, ultimo_log)
    )

  # Dentro de tolerancia (diferencia esperada del 'execute') se reporta solo la
  # cuenta de 'Result: Ok'; la comparacion contra las lineas del archivo solo se
  # muestra si cuadran exactas, para no confundir con una "diferencia" que no es
  # fallo.
  if obtenidos == esperados:
    print("[VALIDACION] %s: %d 'Result: Ok' == %d lineas (header incluido); ultimo comando OK."
          % (nombre_parte, obtenidos, esperados))
  else:
    print("[VALIDACION] %s: %d 'Result: Ok'; ultimo comando OK."
          % (nombre_parte, obtenidos))


def EXPECT(nombre_parte):
  """Ejecuta el batch_script en el equipo remoto y valida que cada comando
  se complete correctamente. 'nombre_parte' es el nombre base del archivo de la
  parte (sin extension), p.ej. 'MTYSAJPSX01_PORTED_20260717_1' o
  'MTYSAJPSX01_PORTED_1'. Lanza una excepcion si falla la conexion o si algun
  comando no completa/reporta error."""
  # -T: no pedir pseudo-terminal (PTY). La CLI de Sonus no la necesita y, si el
  # equipo no puede asignarla, emite 'PTY allocation request failed on channel 0',
  # un warning benigno que ademas ensuciaba la deteccion de errores por 'failed'.
  ssh_cmd = f'ssh -T -p {SSH_PORT} -o User={SSH_USER} {SSH_USER}@{SSH_HOST}'
  if CLI_DEBUG:
    print("[CLI_DEBUG] Abriendo sesion CLI: %s" % ssh_cmd)
  try:
    # '-o User=' fuerza el usuario del .env por encima de cualquier ~/.ssh/config
    # del proceso (p. ej. airflow), para no conectarse como otro usuario (root).
    cmd = pexpect.spawn(ssh_cmd, timeout=CLI_TIMEOUT)
  except Exception as e:
    raise ConnectionError("No se pudo iniciar la conexion ssh a %s:%s (%s)" % (SSH_HOST, SSH_PORT, e))

  # Cronometro de la sesion (solo un timestamp: no retiene salida en memoria).
  # Sirve para reportar cuanto tardo la parte y, cuando el expect corta por
  # pexpect.TIMEOUT, distinguirlo del EOF e informar que se alcanzo CLI_TIMEOUT.
  t_spawn = time.monotonic()

  # El log del pexpect siempre va al archivo LOG_DIR/<parte>.csv. Con CLI_DEBUG
  # ademas se duplica a pantalla SOLO lo que llega del equipo (logfile_read), no
  # lo que enviamos (logfile_send), para no imprimir el CLI_PASSWORD en consola.
  logfile = open("%s/%s.csv" % (LOG_DIR, nombre_parte), "wb")
  cmd.logfile = logfile
  if CLI_DEBUG:
    cmd.logfile_read = sys.stdout.buffer
  cmd.setecho(False)
  # delaybeforesend: pexpect espera este tiempo ANTES de cada sendline. Con 0.8s
  # sumaba una pausa notoria por comando (password/select/execute/exit). Se pone a
  # 0 (sin espera): el flujo es send -> expect(prompt), que ya sincroniza con el
  # equipo, asi que la pausa fija no aporta y solo ralentizaba.
  cmd.delaybeforesend = 0
  cmd.delayafterclose = 0.5
  cmd.delayafterterminate = 0.5

  # Secuencia de comandos a ejecutar; cada uno debe devolver el prompt '> '
  comandos = [
    CLI_PASSWORD,
    f'select target instance {CLI_INSTANCE}',
    f'execute batch_script {nombre_parte}.csv',
    'exit',
  ]

  # Se marca True cuando el 'exit' completa el cierre de la sesion. Sirve para
  # distinguir el codigo de salida ssh 255 "benigno" (el equipo corta la conexion
  # tras el exit) de un 255 real (corte a mitad del batch).
  sesion_cerrada_ok = False

  try:
    # Indices de EOF y TIMEOUT dentro del resultado de expect(): buscar son los
    # patrones "utiles" (prompts); tras ellos van EOF y TIMEOUT en ese orden.
    IDX_EOF = len(buscar)
    IDX_TIMEOUT = len(buscar) + 1

    # Espera inicial del prompt/password: si no aparece, es fallo de conexion.
    idx = cmd.expect(buscar + [pexpect.EOF, pexpect.TIMEOUT])
    if idx == IDX_TIMEOUT:
      raise TimeoutError(
        "Se agoto CLI_TIMEOUT (%ss) esperando el prompt inicial de %s tras %.0fs "
        "(el equipo no respondio a tiempo)" % (CLI_TIMEOUT, SSH_HOST, time.monotonic() - t_spawn)
      )
    if idx >= len(buscar):
      raise ConnectionError("No se obtuvo el prompt inicial de %s (posible fallo de conexion)" % SSH_HOST)

    for c in comandos:
      # El primer comando es el CLI_PASSWORD: nunca mostrarlo en claro, ni en el
      # debug ni en los mensajes de error/excepcion.
      c_mostrado = "<CLI_PASSWORD>" if c == CLI_PASSWORD else c
      if CLI_DEBUG:
        print("[CLI_DEBUG] >>> %s" % c_mostrado)
      cmd.sendline(c)
      idx = cmd.expect(buscar + [pexpect.EOF, pexpect.TIMEOUT])
      # 'exit' cierra la sesion: el EOF es la respuesta esperada, no una falla.
      # (idx == IDX_EOF es EOF; IDX_TIMEOUT es TIMEOUT). Tras el EOF no hay mas
      # prompt ni salida que validar, asi que se corta el loop aqui y se marca la
      # sesion como cerrada correctamente (para tolerar el codigo ssh 255 que deja
      # el equipo al cortar la conexion tras el exit).
      if c == 'exit' and idx == IDX_EOF:
        sesion_cerrada_ok = True
        break
      # Corte por CLI_TIMEOUT: el comando tardo mas que el limite. Es el caso
      # tipico del 'execute batch_script' (el batch gigante que no se valida en
      # linea). Se reporta con la duracion medida y el comando en curso; el
      # detalle de hasta donde llego el batch lo resuelve validar_batch() sobre
      # el log en disco, sin necesidad de retener salida en memoria.
      if idx == IDX_TIMEOUT:
        raise TimeoutError(
          "Se agoto CLI_TIMEOUT (%ss) durante '%s' tras %.0fs: el EMS tardo mas de "
          "lo permitido en completar el comando" % (CLI_TIMEOUT, c_mostrado, time.monotonic() - t_spawn)
        )
      if idx == IDX_EOF:
        raise RuntimeError("El comando '%s' no completo (EOF inesperado: la sesion se corto)" % c_mostrado)

      # El 'execute batch_script' NO se valida aqui: su salida son los CHUNK_SIZE
      # 'Result: Ok' (bloque enorme). Cargarlo desde cmd.before y decodificarlo
      # gastaria memoria de mas; se valida despues contra el logfile en disco con
      # validar_batch(). Para los comandos de control (login/select/exit) si se
      # inspecciona cmd.before, que es corto, buscando palabras de error.
      if c.startswith("execute batch_script"):
        continue

      # Validacion de la salida: buscar patrones de error en lo recibido.
      salida = (cmd.before or b"")
      if isinstance(salida, bytes):
        salida = salida.decode(errors="ignore")
      # Se descartan lineas de ruido benigno del transporte ssh (no de la CLI)
      # que contienen palabras como 'failed' y darian un falso positivo. El caso
      # tipico: 'PTY allocation request failed on channel 0' del banner de login.
      util = "\n".join(
        ln for ln in salida.splitlines()
        if not any(ruido in ln.lower() for ruido in RUIDO_SSH_BENIGNO)
      )
      if any(err in util.lower() for err in ("error", "failed", "invalid", "denied", "not found")):
        raise RuntimeError("El comando '%s' reporto un error: %s" % (c_mostrado, salida.strip()[-300:]))
  finally:
    try:
      cmd.close()
    except Exception:
      pass
    # pexpect.close() no cierra el logfile del usuario: hay que cerrarlo aqui para
    # vaciar el buffer a disco antes de que validar_batch() lo lea. Sin esto el log
    # podria quedar incompleto y dar un falso 'batch incompleto'.
    try:
      logfile.close()
    except Exception:
      pass

  # Verifica el codigo de salida del subproceso ssh. El 255 es el codigo generico
  # de ssh cuando el host remoto corta la conexion; el EMS suele hacerlo tras el
  # 'exit' ("Connection ... closed by remote host") en vez de un cierre limpio con
  # codigo 0. Ese 255 NO es una falla si ya completamos el exit correctamente, asi
  # que se tolera solo en ese caso. Un 255 sin haber cerrado bien (corte a mitad
  # del batch) si es falla.
  codigos_ok = (0, None)
  if sesion_cerrada_ok:
    codigos_ok = (0, None, 255)
  if cmd.exitstatus not in codigos_ok:
    raise RuntimeError("La sesion ssh termino con codigo %s" % cmd.exitstatus)

  # Con la sesion cerrada y el logfile ya en disco: se valida que el EMS haya
  # ejecutado TODOS los comandos del batch (cuenta de 'Result: Ok').
  validar_batch(nombre_parte)


def accion_correctiva():
  """Ejecuta la accion correctiva (ej. reboot) por ssh en el equipo de
  recuperacion. Devuelve True si el comando se envio con codigo 0.
  No lanza excepcion: cualquier fallo se reporta y se devuelve False, para
  que el flujo principal decida si reintenta o aborta.
  Nota: un 'reboot' suele cortar la sesion, por lo que un codigo de salida
  distinto de 0 no necesariamente significa que el reboot no ocurrio."""
  if not RECOVERY_SSH_HOST:
    print("[RECUPERACION] RECOVERY_ENABLED=true pero RECOVERY_SSH_HOST esta vacio; "
          "no se puede ejecutar la accion correctiva.", file=sys.stderr)
    return False

  destino = f"{RECOVERY_SSH_USER}@{RECOVERY_SSH_HOST}"
  # -o BatchMode: no pedir password interactivo; -o StrictHostKeyChecking=no
  # para no bloquearse por host key. ConnectTimeout limita el intento.
  # -o User: fuerza el usuario del .env por encima de cualquier ~/.ssh/config.
  ssh_cmd = (
    f"ssh -p {RECOVERY_SSH_PORT} "
    f"-o User={RECOVERY_SSH_USER} "
    f"-o BatchMode=yes -o StrictHostKeyChecking=no "
    f"-o ConnectTimeout={RECOVERY_TIMEOUT} "
    f"{destino} '{RECOVERY_CMD}'"
  )
  print("[RECUPERACION] Ejecutando accion correctiva en %s: %s" % (destino, RECOVERY_CMD))
  rc = os.system(ssh_cmd)
  if rc != 0:
    print("[RECUPERACION] El comando de recuperacion devolvio codigo %s "
          "(puede ser normal si '%s' corto la sesion)." % (rc, RECOVERY_CMD),
          file=sys.stderr)
    return False
  print("[RECUPERACION] Accion correctiva enviada correctamente.")
  return True


def _intentar_parte_una_tanda(tipo, fecha, parte):
  """Intenta enviar+ejecutar la parte hasta SSH_RETRIES reintentos.
  Devuelve None si tuvo exito, o la ultima excepcion si agoto los reintentos."""
  nombre_parte = "%s_%s" % (nombre_base(tipo, fecha), parte)
  origen = f"{DIRFILES}/{nombre_parte}.csv"

  # Validacion: la parte a enviar debe existir localmente antes del scp.
  if not os.path.isfile(origen):
    raise FileNotFoundError("No se encontro la parte a enviar por scp: %s" % origen)

  destino = f"{SCP_USER}@{SCP_HOST}:{SCP_DEST_PATH}"
  # '-o User=' fuerza el usuario del .env por encima de cualquier ~/.ssh/config
  # del que corra el proceso (p. ej. airflow), para que el scp NUNCA se conecte
  # como otro usuario (root) aunque el config del host diga lo contrario.
  scp_opts = f"-P {SCP_PORT} -o User={SCP_USER}"

  intento = 0
  ultima_exc = None
  while intento <= SSH_RETRIES:
    intento += 1
    try:
      # Validacion del scp: os.system devuelve el estado de salida; !=0 es fallo.
      if CLI_DEBUG:
        print("[CLI_DEBUG] scp %s %s %s" % (scp_opts, origen, destino))
      rc = os.system(f"scp {scp_opts} {origen} {destino}")
      if rc != 0:
        raise ConnectionError(
          "Fallo el scp de la parte %d (codigo %s) hacia %s. "
          "Posible archivo inexistente o fallo de conexion." % (parte, rc, destino)
        )

      # Validacion de la ejecucion remota del batch_script
      EXPECT(nombre_parte)
      return None  # exito
    except Exception as e:
      ultima_exc = e
      if intento <= SSH_RETRIES:
        print("[REINTENTO] Parte %d fallo (intento %d/%d): %s: %s. "
              "Reintentando en %ds..."
              % (parte, intento, SSH_RETRIES + 1, type(e).__name__, e, RETRY_SLEEP),
              file=sys.stderr)
        time.sleep(RETRY_SLEEP)
  return ultima_exc


def ejecutar_parte(tipo, fecha, parte):
  """Envia por scp la parte y ejecuta el batch_script remoto, con reintentos.
  Si la conexion se reinicia, reintenta la MISMA parte hasta SSH_RETRIES veces.

  Si se agotan los reintentos y RECOVERY_ENABLED=true, se ejecuta la accion
  correctiva (ej. reboot remoto), se espera RECOVERY_WAIT segundos y se vuelve
  a intentar la parte con otra tanda completa de reintentos. Esto se repite
  hasta RECOVERY_MAX_CYCLES veces antes de abortar definitivamente."""
  ciclo = 0
  while True:
    exc = _intentar_parte_una_tanda(tipo, fecha, parte)
    if exc is None:
      return  # exito

    # Se agotaron los reintentos de esta tanda.
    if not RECOVERY_ENABLED:
      # Sin recuperacion habilitada: fallo normal de la parte. Se encadena con
      # 'from exc' para conservar el motivo real (p. ej. el TimeoutError de
      # CLI_TIMEOUT) y que la notificacion pueda reconocerlo.
      raise RuntimeError(
        "Parte %d fallo tras %d reintento(s): %s: %s"
        % (parte, SSH_RETRIES + 1, type(exc).__name__, exc)
      ) from exc
    if ciclo >= RECOVERY_MAX_CYCLES:
      # Se agotaron tambien los ciclos de recuperacion (reboot): el equipo
      # sigue mal. Se marca como servidor caido para que el modo rango aborte.
      raise ServidorCaidoError(
        "Parte %d fallo tras %d reintento(s) y %d ciclo(s) de recuperacion; "
        "el equipo remoto sigue sin responder: %s: %s"
        % (parte, SSH_RETRIES + 1, RECOVERY_MAX_CYCLES, type(exc).__name__, exc)
      ) from exc

    ciclo += 1
    print("[RECUPERACION] Parte %d agoto los reintentos; disparando accion "
          "correctiva (ciclo %d/%d)." % (parte, ciclo, RECOVERY_MAX_CYCLES),
          file=sys.stderr)
    accion_correctiva()
    print("[RECUPERACION] Esperando %ds a que el equipo vuelva a estar listo..."
          % RECOVERY_WAIT)
    time.sleep(RECOVERY_WAIT)
    # Vuelve al inicio del while: nueva tanda completa de SSH_RETRIES.


def dia_a_omitir(fecha_dato):
  """Decide si se omite el proceso. Reglas:
    1. Hoy/futuro: el proceso va un dia atras (el CSV del dia se genera al dia
       siguiente), asi que nunca se procesa una fecha_dato >= hoy. Esta regla es
       independiente del calendario (aplica aunque SKIP_SUNDAY/HOLIDAYS esten en
       false) y siempre mira la fecha del dato.
    2. Domingo/festivo: segun SKIP_CHECK_DATE se evalua la fecha de ejecucion
       (hoy) o la fecha de los datos (fecha_dato, formato YYYYMMDD/YYYY-MM-DD).
  Devuelve (True, motivo) o (False, None)."""
  # Regla 1: no procesar hoy ni fechas futuras (aun no existe su archivo).
  f_dato = parse_run_date(fecha_dato)
  if f_dato is not None and f_dato >= date.today():
    return True, ("fecha de hoy o futura (%s): el archivo del dia se genera al "
                  "dia siguiente" % f_dato.isoformat())

  # Regla 2: domingo/festivo.
  if not (SKIP_SUNDAY or SKIP_HOLIDAYS):
    return False, None

  if SKIP_CHECK_DATE == "data":
    fecha_eval = parse_run_date(fecha_dato)
    if fecha_eval is None:
      print("[AVISO] No se pudo interpretar la fecha '%s' para el chequeo de "
            "festivos; se omite la validacion de calendario." % fecha_dato, file=sys.stderr)
      return False, None
  else:
    fecha_eval = date.today()

  return dia_omitido(fecha_eval)


def descargar_origen(base, destino_local):
  """Baja por scp el CSV de origen <base>.csv desde SOURCE_HOST a destino_local.

  Solo se llama en modo fecha cuando el archivo no existe localmente y
  SOURCE_HOST esta configurado. Reutiliza el mismo estilo que el scp de salida:
  '-P <puerto> -o User=<user>' para forzar el usuario por encima de ~/.ssh/config.
  Lanza FileNotFoundError si el archivo remoto no existe o el scp falla, para que
  procesar_dia lo trate como un fallo propio del dia (no aborta el rango)."""
  remoto = "%s@%s:%s/%s.csv" % (SOURCE_USER, SOURCE_HOST, SOURCE_PATH.rstrip("/"), base)
  scp_opts = "-P %s -o User=%s" % (SOURCE_PORT, SOURCE_USER)
  if CLI_DEBUG:
    print("[CLI_DEBUG] scp %s %s %s" % (scp_opts, remoto, destino_local))
  print("[ORIGEN] Descargando %s.csv desde %s..." % (base, SOURCE_HOST))
  rc = os.system("scp %s %s %s" % (scp_opts, remoto, destino_local))
  if rc != 0 or not os.path.isfile(destino_local):
    raise FileNotFoundError(
      "No se pudo descargar el CSV de origen (codigo scp %s) desde %s. "
      "Verifica que el archivo exista en el servidor de origen y las "
      "credenciales SOURCE_*." % (rc, remoto)
    )
  print("[ORIGEN] Descargado: %s" % destino_local)


def origen_responde_ping():
  """Sondea SOURCE_HOST con ping para saber si el servidor de origen esta vivo.

  Envia SOURCE_PING_TRIES pruebas, una cada SOURCE_PING_INTERVAL segundos, con
  SOURCE_PING_COUNT paquetes por prueba. Devuelve True en cuanto UNA prueba
  responde (corta el sondeo); False si ninguna respondio tras agotar las pruebas.
  """
  # -c cuenta de paquetes, -w deadline total en segundos (linux). Salida a
  # /dev/null: solo interesa el codigo de retorno.
  cmd = "ping -c %d -w %d %s >/dev/null 2>&1" % (
    SOURCE_PING_COUNT, max(1, SOURCE_PING_COUNT), SOURCE_HOST)
  for intento in range(1, SOURCE_PING_TRIES + 1):
    if CLI_DEBUG:
      print("[CLI_DEBUG] ping (prueba %d/%d): %s" % (intento, SOURCE_PING_TRIES, cmd))
    if os.system(cmd) == 0:
      print("[PING] %s respondio en la prueba %d/%d."
            % (SOURCE_HOST, intento, SOURCE_PING_TRIES))
      return True
    print("[PING] %s no respondio (prueba %d/%d)."
          % (SOURCE_HOST, intento, SOURCE_PING_TRIES), file=sys.stderr)
    if intento < SOURCE_PING_TRIES:
      time.sleep(SOURCE_PING_INTERVAL)
  return False


def asegurar_origen(tipo, fecha):
  """Garantiza que el CSV <PREFIX>_<TYPE>_<fecha>.csv exista en DIRFILES.

  Si no esta local y hay SOURCE_HOST, lo baja por scp. Si la descarga falla o el
  archivo sigue sin aparecer, hace ping para distinguir la causa y lanza:
    - OrigenCaidoError          si el servidor de origen no responde al ping.
    - ArchivoOrigenFaltanteError si responde pero el archivo no existe.
  Con SOURCE_HOST vacio no hay descarga ni ping: solo valida la existencia local.
  """
  base = nombre_base(tipo, fecha)
  archivo = "%s/%s.csv" % (DIRFILES, base)

  if os.path.isfile(archivo):
    return archivo

  if SOURCE_HOST:
    try:
      descargar_origen(base, archivo)
    except FileNotFoundError as e:
      # Fallo la descarga: se hace ping para saber si es servidor caido o archivo
      # inexistente. El ping puede tardar (hasta ~5 min con los defaults).
      print("[ORIGEN] Fallo la descarga de %s.csv; se sondea %s por ping..."
            % (base, SOURCE_HOST))
      if not origen_responde_ping():
        raise OrigenCaidoError(
          "El servidor de origen %s no responde al ping tras %d prueba(s); no se "
          "pudo obtener %s.csv." % (SOURCE_HOST, SOURCE_PING_TRIES, base)
        ) from e
      raise ArchivoOrigenFaltanteError(
        "El servidor de origen %s responde, pero el archivo %s.csv no existe/no "
        "se pudo descargar (probablemente aun no se genero)." % (SOURCE_HOST, base)
      ) from e

  if not os.path.isfile(archivo):
    raise ArchivoOrigenFaltanteError(
      "No se encontro el archivo de origen para procesar: %s" % archivo
    )
  return archivo


def procesar_dia(tipo, fecha, host):
  """Procesa un unico dia (una fecha). Realiza particion en chunks, envio y
  ejecucion remota de cada parte con reintentos/recuperacion/checkpoint, y
  las notificaciones de inicio/fin/error correspondientes a ese dia.

  Devuelve True si el dia se completo correctamente, False si fallo por una
  causa propia de ese dia (ej. archivo inexistente): el orquestador de rango
  puede continuar con los dias siguientes.

  Propaga ServidorCaidoError si el equipo remoto agoto reintentos y ciclos de
  recuperacion: en ese caso el orquestador debe abortar el rango (no tiene
  sentido seguir intentando dias contra un servidor caido)."""
  base = nombre_base(tipo, fecha)
  archivo = f"{DIRFILES}/{base}.csv"

  send_notification(
    "start",
    "[Portabilidad] INICIO %s %s" % (tipo, fecha),
    "El proceso de portabilidad %s ha iniciado.\n"
    "Host: %s\nTipo: %s\nFecha: %s\nArchivo: %s\nDestino scp: %s@%s\n"
    % (FILE_PREFIX, host, tipo, fecha, archivo, SCP_USER, SCP_HOST),
  )

  comandos_ok = 0
  total_partes = None

  try:
    # --- Origen: descarga por scp si falta y valida existencia (con ping) ---
    # (solo modo fecha; el snapshot de full_sync no entra aqui). En el modo rango
    # este archivo ya fue asegurado por el pre-chequeo, asi que aqui suele ser un
    # no-op. asegurar_origen lanza OrigenCaidoError/ArchivoOrigenFaltanteError.
    asegurar_origen(tipo, fecha)

    # Marca de tiempo para medir cuanto tarda la preparacion (lectura + troceo)
    # antes del primer envio. Ayuda a ubicar retrasos entre la notificacion y el
    # primer comando en el equipo.
    t_prep = time.monotonic()
    with open(archivo, 'r') as fp:
      Lines = fp.readlines()

    total_lineas = len(Lines)

    # --- Particion en partes (chunks) ---
    # Calculo explicito del numero de partes: ceil(total_lineas / CHUNK_SIZE),
    # con minimo 1 parte aunque el archivo este vacio. Esto evita la "parte
    # fantasma" que generaba el while/else anterior cuando el total era multiplo
    # exacto de CHUNK_SIZE.
    total_partes = max(1, (total_lineas + CHUNK_SIZE - 1) // CHUNK_SIZE)

    for part in range(1, total_partes + 1):
      num0 = (part - 1) * CHUNK_SIZE
      num1 = part * CHUNK_SIZE
      extract_lines(
        archivo,
        f"{DIRFILES}/{base}_{part}.csv",
        num0, num1,
      )

    print("[INFO] (%s) Archivo de %d linea(s); se generaron %d parte(s) en %.1fs "
          "(lectura + troceo)."
          % (fecha, total_lineas, total_partes, time.monotonic() - t_prep))

    # --- Reanudacion: partes ya completadas segun el checkpoint ---
    print("[CHECKPOINT] (%s) Archivo de reanudacion: %s" % (fecha, checkpoint_path(tipo, fecha)))
    ya_hechas = leer_checkpoint(tipo, fecha)
    ya_hechas = {p for p in ya_hechas if 1 <= p <= total_partes}
    comandos_ok = len(ya_hechas)
    if ya_hechas:
      print("[REANUDAR] (%s) Se reanuda: %d de %d parte(s) ya completadas (%s)."
            % (fecha, comandos_ok, total_partes, ",".join(str(p) for p in sorted(ya_hechas))))
    else:
      print("[CHECKPOINT] (%s) Sin checkpoint previo: se procesan las %d parte(s) desde el inicio."
            % (fecha, total_partes))

    # --- Procesamiento de cada parte (con reintentos y checkpoint) ---
    for check in range(1, total_partes + 1):
      if check in ya_hechas:
        print("[SALTAR] (%s) Parte %d/%d ya completada; se omite." % (fecha, check, total_partes))
        continue

      # Envio + ejecucion remota con reintentos/recuperacion ante fallo.
      ejecutar_parte(tipo, fecha, check)

      # Solo se marca/cuenta cuando la parte se completo realmente.
      marcar_parte_completada(tipo, fecha, check)
      comandos_ok += 1
      print("[INFO] (%s) Parte %d/%d procesada correctamente." % (fecha, check, total_partes))

      # No dormir despues de la ultima parte.
      if check < total_partes and SLEEP_BETWEEN > 0:
        print("[INFO] (%s) Pausa de %ds antes de la parte %d/%d (SLEEP_BETWEEN)."
              % (fecha, SLEEP_BETWEEN, check + 1, total_partes))
        time.sleep(SLEEP_BETWEEN)

    # Validacion final: todas las partes deben haberse ejecutado.
    if comandos_ok != total_partes:
      raise RuntimeError(
        "No se ejecutaron todos los comandos: %d de %d completados." % (comandos_ok, total_partes)
      )

    # Todo OK: se limpia el checkpoint para el proximo run.
    borrar_checkpoint(tipo, fecha)

  except OrigenCaidoError as e:
    # El servidor de ORIGEN no responde al ping: se notifica y se propaga para
    # que el rango aborte (no tiene sentido buscar los CSV de los demas dias).
    send_notification(
      "error",
      "[Portabilidad] ERROR (origen caido) %s %s" % (tipo, fecha),
      "El proceso de portabilidad %s no pudo obtener el archivo de origen: el "
      "servidor de origen (%s) no responde al ping.\n"
      "Host: %s\nTipo: %s\nFecha: %s\nDetalle: %s\n"
      % (FILE_PREFIX, SOURCE_HOST, host, tipo, fecha, e),
    )
    print("[ERROR] (%s) ORIGEN CAIDO: %s" % (fecha, e), file=sys.stderr)
    raise
  except ArchivoOrigenFaltanteError as e:
    # El origen responde pero el archivo del dia no existe (aun no se genero):
    # es un fallo propio del dia, no aborta el rango.
    send_notification(
      "error",
      "[Portabilidad] ERROR (archivo no encontrado) %s %s" % (tipo, fecha),
      "El proceso de portabilidad %s no encontro el archivo de origen del dia.\n"
      "Host: %s\nTipo: %s\nFecha: %s\nDetalle: %s\n"
      % (FILE_PREFIX, host, tipo, fecha, e),
    )
    print("[ERROR] (%s) ARCHIVO FALTANTE: %s" % (fecha, e), file=sys.stderr)
    return False
  except ServidorCaidoError as e:
    # El equipo remoto sigue caido tras la recuperacion: se notifica este dia
    # y se propaga para que el modo rango aborte los dias restantes. Si la causa
    # raiz fue un corte por CLI_TIMEOUT, se aclara en el cuerpo (el tiempo de
    # ejecucion permitido fue demasiado corto, no una caida real del equipo).
    to = causa_timeout_cli(e)
    nota_timeout = (
      "\nNota: el fallo se origino por agotar CLI_TIMEOUT=%ss (el comando no "
      "alcanzo a completarse dentro del limite); considera aumentarlo." % CLI_TIMEOUT
      if to is not None else ""
    )
    send_notification(
      "error",
      "[Portabilidad] ERROR (servidor caido) %s %s" % (tipo, fecha),
      "El proceso de portabilidad %s fallo: el equipo remoto sigue "
      "sin responder tras la accion correctiva.\n"
      "Host: %s\nTipo: %s\nFecha: %s\n"
      "Partes procesadas: %d de %s\nDetalle: %s\n%s"
      % (FILE_PREFIX, host, tipo, fecha, comandos_ok, total_partes, e, nota_timeout),
    )
    print("[ERROR] (%s) SERVIDOR CAIDO: %s" % (fecha, e), file=sys.stderr)
    raise
  except Exception as e:
    # Si el fallo (o su causa encadenada) es un corte por CLI_TIMEOUT, se envia
    # una notificacion especifica: el problema no es una desconexion sino que el
    # tiempo de ejecucion permitido (CLI_TIMEOUT) fue demasiado corto para el
    # comando. El flujo de reintentos/recuperacion no cambia.
    to = causa_timeout_cli(e)
    if to is not None:
      send_notification(
        "error",
        "[Portabilidad] ERROR (tiempo de ejecucion agotado) %s %s" % (tipo, fecha),
        "El proceso de portabilidad %s fallo porque se agoto el tiempo de "
        "ejecucion permitido de la CLI (CLI_TIMEOUT=%ss): el comando no alcanzo "
        "a completarse dentro del limite. Considera aumentar CLI_TIMEOUT.\n"
        "Host: %s\nTipo: %s\nFecha: %s\n"
        "Partes procesadas: %d de %s\nDetalle: %s\n"
        % (FILE_PREFIX, CLI_TIMEOUT, host, tipo, fecha, comandos_ok, total_partes, to),
      )
      print("[ERROR] (%s) CLI_TIMEOUT agotado: %s" % (fecha, to), file=sys.stderr)
      return False

    send_notification(
      "error",
      "[Portabilidad] ERROR %s %s" % (tipo, fecha),
      "El proceso de portabilidad %s fallo.\n"
      "Host: %s\nTipo: %s\nFecha: %s\n"
      "Tipo de fallo: %s\n"
      "Partes procesadas: %d de %s\nDetalle: %s\n"
      % (FILE_PREFIX, host, tipo, fecha, type(e).__name__, comandos_ok, total_partes, e),
    )
    print("[ERROR] (%s) %s: %s" % (fecha, type(e).__name__, e), file=sys.stderr)
    return False

  send_notification(
    "end",
    "[Portabilidad] FIN OK %s %s" % (tipo, fecha),
    "El proceso de portabilidad %s finalizo correctamente.\n"
    "Host: %s\nTipo: %s\nFecha: %s\n"
    "Todas las partes ejecutadas: %d de %d\n"
    % (FILE_PREFIX, host, tipo, fecha, comandos_ok, total_partes),
  )
  print("[INFO] (%s) Proceso del dia finalizado correctamente." % fecha)
  return True


def rango_de_fechas(desde, hasta):
  """Genera cada fecha (objeto date) desde 'desde' hasta 'hasta' inclusive,
  un dia a la vez. Si 'hasta' es anterior a 'desde', no genera nada."""
  actual = desde
  while actual <= hasta:
    yield actual
    actual = actual + timedelta(days=1)


# Patrones (REGEX) que se esperan del CLI remoto: prompt de password y prompt del
# shell CLI. pexpect.expect() interpreta estos strings como expresiones regulares.
#
# El prompt real del equipo tiene DOS formas segun la fase:
#   1) Tras el login (banner 'Sonus Insight...') el equipo muestra un prompt
#      generico '> ' que AUN no incluye la instancia.
#   2) Ya dentro de la sesion CLI (tras seleccionar el target) el prompt puede ser
#      de la forma 'PSX:V12.02.07R000:mtysajpsx01>'.
# Ambos terminan en '>', asi que el patron '>\s*' (mayor-que + espacios/salto
# opcionales) casa las dos fases. NO anclar al nombre de la instancia: el prompt
# inicial no lo trae y la sesion se colgaba hasta el timeout esperandolo. Tampoco
# anclar con '$': la salida llega en fragmentos y podria casar prematuramente.
# Global de modulo: lo usa EXPECT().
buscar = ['Password:\\s*', '>\\s*']


def resolver_fechas(date=None, date_from=None, date_to=None):
  """Convierte los parametros de fecha en la lista de dias (YYYYMMDD) a procesar.
  Acepta un dia unico (date) o un rango inclusivo (date_from/date_to), pero no
  ambos. Lanza ValueError con un mensaje claro ante combinaciones invalidas."""
  if date_from or date_to:
    if not (date_from and date_to):
      raise ValueError("Para procesar un rango debes indicar date_from y date_to.")
    if date:
      raise ValueError("Usa date (dia unico) o date_from/date_to (rango), no ambos.")

    d_from = parse_run_date(date_from)
    d_to = parse_run_date(date_to)
    if d_from is None or d_to is None:
      raise ValueError("Formato de fecha invalido en date_from/date_to "
                       "(usa YYYYMMDD o YYYY-MM-DD).")
    if d_to < d_from:
      raise ValueError("date_to (%s) es anterior a date_from (%s)." % (date_to, date_from))

    fechas = [d.strftime("%Y%m%d") for d in rango_de_fechas(d_from, d_to)]
    print("[INFO] Modo RANGO: %d dia(s) de %s a %s." % (len(fechas), date_from, date_to))
    return fechas

  if date:
    return [date]

  raise ValueError("Debes indicar date, o bien date_from y date_to.")


def _procesar_lista(tipos, ids, host, aplicar_calendario):
  """Procesa una lista de 'ids' (fechas en modo dia a dia, o un unico label en
  modo snapshot) para cada tipo de 'tipos' (p. ej. PORTED y DELETED).

  El orden es POR DIA: para cada id se procesan todos los tipos en el orden dado
  (PORTED y luego DELETED) antes de pasar al siguiente dia. Asi la portabilidad
  de un dia queda completa (altas y bajas) antes de avanzar, en vez de correr
  todos los PORTED del rango y al final todos los DELETED.

  El calendario (domingos/festivos) se evalua una sola vez por dia y, si se
  omite, se saltan todos los tipos de ese dia. Un (tipo,dia) que falla por causa
  propia no detiene a los demas; un servidor caido tras la recuperacion aborta
  todo lo restante. Devuelve el codigo de salida (0/1)."""
  ok = []
  fallidos = []
  omitidos = []
  no_intentados = []
  servidor_caido = False

  # --- Filtro de calendario: se resuelven primero los dias a procesar ---
  # El calendario (domingos/festivos/hoy) solo aplica al proceso por fecha, no a
  # un snapshot del full_sync. Se evalua una vez por dia: si se omite, se saltan
  # todos los tipos de ese dia.
  dias = []
  for ident in ids:
    if aplicar_calendario:
      omitir, motivo = dia_a_omitir(ident)
      if omitir:
        print("[OMITIDO] (%s) No se ejecuta: %s." % (ident, motivo))
        omitidos.append((ident, motivo))
        continue
    dias.append(ident)

  # --- Pre-chequeo (solo modo fecha): todos los archivos deben existir ---
  # Antes de ejecutar nada se asegura que cada (tipo,dia) tenga su CSV (se baja
  # por scp si hace falta). Si el servidor de origen no responde -> se aborta con
  # alarma "origen caido". Si responde pero falta algun archivo -> se aborta el
  # rango completo con una unica alarma listando los faltantes (no se ejecuta
  # nada a medias). El snapshot (aplicar_calendario=False) no pre-chequea.
  if aplicar_calendario and SOURCE_HOST:
    faltantes = []
    try:
      for ident in dias:
        for tipo in tipos:
          try:
            asegurar_origen(tipo, ident)
          except ArchivoOrigenFaltanteError as e:
            faltantes.append("%s %s" % (tipo, ident))
            print("[PRECHEQUEO] Falta %s %s: %s" % (tipo, ident, e), file=sys.stderr)
    except OrigenCaidoError as e:
      send_notification(
        "error",
        "[Portabilidad] ABORTADO (origen caido)",
        "Se aborto el rango en el pre-chequeo: el servidor de origen (%s) no "
        "responde al ping.\nHost: %s\nDetalle: %s\n" % (SOURCE_HOST, host, e),
      )
      print("[ABORTAR] Origen caido en el pre-chequeo: %s" % e, file=sys.stderr)
      print("[RESUMEN] OK: 0 | Fallidos: 0 | Omitidos: %d | ABORTADO (origen caido)"
            % len(omitidos))
      return 1

    if faltantes:
      send_notification(
        "error",
        "[Portabilidad] ABORTADO (archivos faltantes)",
        "Se aborto el rango en el pre-chequeo: el servidor de origen responde "
        "pero faltan %d archivo(s) de origen (no se ejecuta nada a medias).\n"
        "Host: %s\nFaltantes: %s\n" % (len(faltantes), host, ", ".join(faltantes)),
      )
      print("[ABORTAR] Faltan %d archivo(s) de origen: %s"
            % (len(faltantes), ", ".join(faltantes)), file=sys.stderr)
      print("[RESUMEN] OK: 0 | Fallidos: %d | Omitidos: %d | ABORTADO (archivos "
            "faltantes)" % (len(faltantes), len(omitidos)))
      return 1

  for i, ident in enumerate(dias):
    for tipo in tipos:
      etiqueta = "%s %s" % (tipo, ident)
      try:
        if procesar_dia(tipo, ident, host):
          ok.append(etiqueta)
        else:
          # Fallo propio (ej. archivo inexistente): se continua con el resto.
          fallidos.append(etiqueta)
      except ServidorCaidoError:
        # El servidor sigue caido tras la recuperacion: no tiene sentido seguir
        # intentando (y rebooteando) lo restante. Se aborta todo: los tipos que
        # falten de este dia y todos los dias siguientes.
        servidor_caido = True
        fallidos.append(etiqueta)
        no_intentados = ["%s %s" % (t, ident) for t in tipos[tipos.index(tipo) + 1:]]
        no_intentados += ["%s %s" % (t, d) for d in dias[i + 1:] for t in tipos]
        print("[ABORTAR] (%s) Servidor caido tras la recuperacion; se abortan los "
              "%d restante(s)." % (etiqueta, len(no_intentados)), file=sys.stderr)
        if no_intentados:
          send_notification(
            "error",
            "[Portabilidad] ABORTADO",
            "Se aborto porque el equipo remoto sigue caido tras la "
            "accion correctiva.\n"
            "Host: %s\nUltimo intentado: %s\n"
            "No intentados (%d): %s\n"
            "Reanuda cuando el equipo este disponible; los OK ya estan hechos y "
            "los pendientes conservan su checkpoint.\n"
            % (host, etiqueta, len(no_intentados), ", ".join(no_intentados)),
          )
        break
    if servidor_caido:
      break

  print("[RESUMEN] OK: %d | Fallidos: %d | Omitidos: %d | No intentados: %d"
        % (len(ok), len(fallidos), len(omitidos), len(no_intentados)))
  if fallidos:
    print("[RESUMEN] Fallidos: %s" % ", ".join(fallidos), file=sys.stderr)
  if servidor_caido:
    print("[RESUMEN] ABORTADO por servidor caido. No intentados: %s"
          % ", ".join(no_intentados), file=sys.stderr)

  return 1 if (fallidos or servidor_caido) else 0


def run(tipo, date=None, date_from=None, date_to=None, label=None):
  """Punto de entrada reutilizable (lo usan el CLI y full_sync.py). Ejecuta la
  portabilidad de 'tipo' en uno de dos modos:

    - Modo FECHA (dia a dia): pasa date o date_from/date_to. Los CSV se llaman
      <PREFIX>_<TYPE>_<fecha>.csv y se omiten domingos/festivos (calendario).
    - Modo SNAPSHOT (full_sync): pasa label (o nada). El CSV se llama
      <PREFIX>_<TYPE>[_<label>].csv y NO se aplica calendario (un snapshot del
      estado total no depende del dia de ejecucion).

  'tipo' puede ser un string (p. ej. 'PORTED', como lo llama full_sync.py) o una
  lista/tupla de tipos (p. ej. ['PORTED', 'DELETED'] desde el CLI en modo BOTH).
  Con varios tipos el orden es POR DIA: se completan todos los tipos de un dia
  antes de pasar al siguiente.

  No se pueden mezclar los dos modos. Devuelve el codigo de salida (0 = OK;
  1 = hubo fallos o se aborto). No llama a sys.exit(): el llamador decide."""
  # Valida que toda la configuracion obligatoria provenga del .env antes de operar.
  validar_configuracion()
  host = socket.gethostname()

  tipos = [tipo] if isinstance(tipo, str) else list(tipo)

  modo_fecha = bool(date or date_from or date_to)
  if modo_fecha and label is not None:
    raise ValueError("Usa el modo fecha (date/date-from/date-to) O el modo "
                     "snapshot (label), no ambos.")

  if modo_fecha:
    ids = resolver_fechas(date=date, date_from=date_from, date_to=date_to)
    return _procesar_lista(tipos, ids, host, aplicar_calendario=True)

  # Modo snapshot: un unico "id" que es el label (o cadena vacia => <PREFIX>_<TYPE>.csv).
  ident = (label or "").strip()
  return _procesar_lista(tipos, [ident], host, aplicar_calendario=False)


def main(argv=None):
  """Punto de entrada del CLI. Dos modos, mutuamente excluyentes:
    Dia a dia (portabilidad por fecha):
      --date YYYYMMDD                      -> un solo dia
      --date-from YYYYMMDD --date-to YYYYMMDD -> un rango, dia a dia
    Snapshot (diferencias del full_sync, sin fecha):
      --label ETIQUETA  (o sin argumento)  -> <PREFIX>_<TYPE>[_<label>].csv

  --type es opcional y por defecto BOTH: corre PORTED y luego DELETED en la
  misma invocacion (lo habitual en la portabilidad diaria). Pasa --type PORTED
  o --type DELETED para acotar a uno solo.
  """
  parser = argparse.ArgumentParser(description='Portabilidad Process')
  parser.add_argument('--type', type=str, default='BOTH',
                      help='PORTED, DELETED o BOTH (ambos). Por defecto BOTH: '
                           'corre PORTED y luego DELETED en la misma invocacion.')
  parser.add_argument('--date', type=str, help='Fecha unica a procesar (YYYYMMDD)')
  parser.add_argument('--date-from', dest='date_from', type=str,
                      help='Inicio del rango de fechas a procesar (YYYYMMDD)')
  parser.add_argument('--date-to', dest='date_to', type=str,
                      help='Fin del rango de fechas a procesar (YYYYMMDD), inclusive')
  parser.add_argument('--label', type=str,
                      help='Etiqueta opcional para el snapshot (sin fecha). '
                           'Nombra el CSV como <PREFIX>_<TYPE>[_<label>].csv.')

  args = parser.parse_args(argv)

  tipo = (args.type or '').strip().upper()
  if tipo == 'BOTH':
    tipos = ['PORTED', 'DELETED']
  elif tipo in ('PORTED', 'DELETED'):
    tipos = [tipo]
  else:
    print("[ERROR] --type debe ser PORTED, DELETED o BOTH (recibido: %r)"
          % args.type, file=sys.stderr)
    return 2

  try:
    # Se pasa la lista completa de tipos a run(): el orden es POR DIA (todos los
    # tipos de un dia antes de pasar al siguiente), no todos los PORTED del rango
    # y al final todos los DELETED. run() ya devuelve el peor codigo de salida.
    return run(tipos, date=args.date, date_from=args.date_from,
               date_to=args.date_to, label=args.label)
  except ValueError as e:
    print("[ERROR] %s" % e, file=sys.stderr)
    return 2


if __name__ == "__main__":
  sys.exit(main())
