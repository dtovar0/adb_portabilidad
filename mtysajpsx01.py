import pexpect, argparse, sys, os
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
  load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except ImportError:
  pass


def env_bool(name, default=False):
  return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "si", "y")


class ServidorCaidoError(Exception):
  """Se lanza cuando una parte agota reintentos Y los ciclos de recuperacion
  (reboot). Indica que el equipo remoto sigue mal: en modo rango, esto debe
  abortar los dias restantes en lugar de seguir intentando (y rebooteando)."""
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
SSH_HOST = os.environ.get("SSH_HOST", "")
# Puerto de la SESION CLI del EMS (ssh interactivo a la consola SONUS/EMS). En
# estos equipos suele ser un puerto propio de la CLI (p. ej. 8122), distinto del
# SSH estandar del sistema operativo por el que viaja el scp de archivos.
SSH_PORT = os.environ.get("SSH_PORT", "")
SSH_USER = os.environ.get("SSH_USER", "")
CLI_PASSWORD = os.environ.get("CLI_PASSWORD", "")
CLI_INSTANCE = os.environ.get("CLI_INSTANCE", "")
FILE_PREFIX = os.environ.get("FILE_PREFIX", "")
SCP_USER = os.environ.get("SCP_USER", "")
# Puerto del scp de los archivos. Es el SSH del SISTEMA OPERATIVO (por defecto 22),
# NO el de la CLI: el scp copia archivos al filesystem del equipo, no entra a la
# consola CLI. Se separa de SSH_PORT porque en el EMS son puertos distintos.
SCP_PORT = os.environ.get("SCP_PORT", "22")
SCP_DEST_PATH = os.environ.get("SCP_DEST_PATH", "")

# Modo debug de la sesion CLI (pexpect) y del scp. Con true:
#   - duplica TODA la salida del pexpect a la pantalla (ademas del archivo de log
#     LOG_DIR/<parte>.csv, que se conserva),
#   - imprime el comando ssh que se lanza, los comandos que se envian a la CLI y
#     el comando scp completo.
# Se activa con CLI_DEBUG=true o, para reutilizar el mismo switch del full_sync,
# con SYNC_DEBUG=true. Por defecto false (salida solo al archivo de log).
CLI_DEBUG = env_bool("CLI_DEBUG", False) or env_bool("SYNC_DEBUG", False)

# ---------------------------------------------------------------------------
# Rutas y parametros del proceso
# ---------------------------------------------------------------------------
DIRFILES = os.environ.get("DIRFILES", "")
LOG_DIR = os.environ.get("LOG_DIR", "")
CHUNK_SIZE = int(os.environ.get("CHUNK_SIZE", "20000"))
SLEEP_BETWEEN = int(os.environ.get("SLEEP_BETWEEN", "120"))

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
SKIP_CHECK_DATE = os.environ.get("SKIP_CHECK_DATE", "run").strip().lower()


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
  """Registra (append + flush) que una parte se completo, para poder reanudar."""
  os.makedirs(CHECKPOINT_DIR, exist_ok=True)
  with open(checkpoint_path(tipo, fecha), "a") as f:
    f.write("%d\n" % parte)
    f.flush()
    os.fsync(f.fileno())


def borrar_checkpoint(tipo, fecha):
  """Elimina el checkpoint al terminar todo el proceso correctamente."""
  ruta = checkpoint_path(tipo, fecha)
  try:
    if os.path.isfile(ruta):
      os.remove(ruta)
  except OSError:
    pass


def extract_lines(input_file, output_file, start_line, end_line, part):
  with open(input_file, 'r') as infile:
    lines = infile.readlines()

  with open(output_file, 'w') as outfile:
    if (part != 1):
      outfile.write("?EMS::CLI?\n")

    for i in range(start_line, end_line):
      if 0 <= i < len(lines):
        outfile.write(lines[i])


def EXPECT(nombre_parte):
  """Ejecuta el batch_script en el equipo remoto y valida que cada comando
  se complete correctamente. 'nombre_parte' es el nombre base del archivo de la
  parte (sin extension), p.ej. 'MTYSAJPSX01_PORTED_20260717_1' o
  'MTYSAJPSX01_PORTED_1'. Lanza una excepcion si falla la conexion o si algun
  comando no completa/reporta error."""
  ssh_cmd = f'ssh -p {SSH_PORT} -o User={SSH_USER} {SSH_USER}@{SSH_HOST}'
  if CLI_DEBUG:
    print("[CLI_DEBUG] Abriendo sesion CLI: %s" % ssh_cmd)
  try:
    # '-o User=' fuerza el usuario del .env por encima de cualquier ~/.ssh/config
    # del proceso (p. ej. airflow), para no conectarse como otro usuario (root).
    cmd = pexpect.spawn(ssh_cmd, timeout=2400)
  except Exception as e:
    raise ConnectionError("No se pudo iniciar la conexion ssh a %s:%s (%s)" % (SSH_HOST, SSH_PORT, e))

  # El log del pexpect siempre va al archivo LOG_DIR/<parte>.csv. Con CLI_DEBUG
  # ademas se duplica a pantalla SOLO lo que llega del equipo (logfile_read), no
  # lo que enviamos (logfile_send), para no imprimir el CLI_PASSWORD en consola.
  cmd.logfile = open("%s/%s.csv" % (LOG_DIR, nombre_parte), "wb")
  if CLI_DEBUG:
    cmd.logfile_read = sys.stdout.buffer
  cmd.setecho(False)
  cmd.delaybeforesend = 0.8
  cmd.delayafterclose = 0.5
  cmd.delayafterterminate = 0.5

  # Secuencia de comandos a ejecutar; cada uno debe devolver el prompt '> '
  comandos = [
    CLI_PASSWORD,
    f'select target instance {CLI_INSTANCE}',
    f'execute batch_script {nombre_parte}.csv',
    'exit',
  ]

  try:
    # Espera inicial del prompt/password: si no aparece, es fallo de conexion.
    idx = cmd.expect(buscar + [pexpect.EOF, pexpect.TIMEOUT])
    if idx >= len(buscar):
      raise ConnectionError("No se obtuvo el prompt inicial de %s (posible fallo de conexion)" % SSH_HOST)

    for c in comandos:
      if CLI_DEBUG:
        # El primer comando es el CLI_PASSWORD: no lo imprimimos en claro.
        mostrado = "<CLI_PASSWORD>" if c == CLI_PASSWORD else c
        print("[CLI_DEBUG] >>> %s" % mostrado)
      cmd.sendline(c)
      idx = cmd.expect(buscar + [pexpect.EOF, pexpect.TIMEOUT])
      if idx >= len(buscar):
        raise RuntimeError("El comando '%s' no completo (EOF/TIMEOUT)" % c)

      # Validacion de la salida: buscar patrones de error en lo recibido.
      salida = (cmd.before or b"")
      if isinstance(salida, bytes):
        salida = salida.decode(errors="ignore")
      if any(err in salida.lower() for err in ("error", "failed", "invalid", "denied", "not found")):
        raise RuntimeError("El comando '%s' reporto un error: %s" % (c, salida.strip()[-300:]))
  finally:
    try:
      cmd.close()
    except Exception:
      pass

  # Verifica que el subproceso ssh haya terminado con codigo 0
  if cmd.exitstatus not in (0, None):
    raise RuntimeError("La sesion ssh termino con codigo %s" % cmd.exitstatus)


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

  destino = f"{SCP_USER}@{SSH_HOST}:{SCP_DEST_PATH}"
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
      # Sin recuperacion habilitada: fallo normal de la parte.
      raise RuntimeError(
        "Parte %d fallo tras %d reintento(s): %s: %s"
        % (parte, SSH_RETRIES + 1, type(exc).__name__, exc)
      )
    if ciclo >= RECOVERY_MAX_CYCLES:
      # Se agotaron tambien los ciclos de recuperacion (reboot): el equipo
      # sigue mal. Se marca como servidor caido para que el modo rango aborte.
      raise ServidorCaidoError(
        "Parte %d fallo tras %d reintento(s) y %d ciclo(s) de recuperacion; "
        "el equipo remoto sigue sin responder: %s: %s"
        % (parte, SSH_RETRIES + 1, RECOVERY_MAX_CYCLES, type(exc).__name__, exc)
      )

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
  """Decide si se omite el proceso por domingo/festivo. Segun SKIP_CHECK_DATE
  se evalua la fecha de ejecucion (hoy) o la fecha de los datos (fecha_dato,
  formato YYYYMMDD/YYYY-MM-DD). Devuelve (True, motivo) o (False, None)."""
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
    "Host: %s\nTipo: %s\nFecha: %s\nArchivo: %s\nDestino: %s@%s\n"
    % (FILE_PREFIX, host, tipo, fecha, archivo, SCP_USER, SSH_HOST),
  )

  comandos_ok = 0
  total_partes = None

  try:
    # --- Validacion: el archivo de origen debe existir ---
    if not os.path.isfile(archivo):
      raise FileNotFoundError(
        "No se encontro el archivo de origen para procesar: %s" % archivo
      )

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
        num0, num1, part,
      )

    print("[INFO] (%s) Archivo de %d linea(s); se generaron %d parte(s)."
          % (fecha, total_lineas, total_partes))

    # --- Reanudacion: partes ya completadas segun el checkpoint ---
    ya_hechas = leer_checkpoint(tipo, fecha)
    ya_hechas = {p for p in ya_hechas if 1 <= p <= total_partes}
    comandos_ok = len(ya_hechas)
    if ya_hechas:
      print("[REANUDAR] (%s) Se reanuda: %d de %d parte(s) ya completadas (%s)."
            % (fecha, comandos_ok, total_partes, ",".join(str(p) for p in sorted(ya_hechas))))

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
      if check < total_partes:
        time.sleep(SLEEP_BETWEEN)

    # Validacion final: todas las partes deben haberse ejecutado.
    if comandos_ok != total_partes:
      raise RuntimeError(
        "No se ejecutaron todos los comandos: %d de %d completados." % (comandos_ok, total_partes)
      )

    # Todo OK: se limpia el checkpoint para el proximo run.
    borrar_checkpoint(tipo, fecha)

  except ServidorCaidoError as e:
    # El equipo remoto sigue caido tras la recuperacion: se notifica este dia
    # y se propaga para que el modo rango aborte los dias restantes.
    send_notification(
      "error",
      "[Portabilidad] ERROR (servidor caido) %s %s" % (tipo, fecha),
      "El proceso de portabilidad %s fallo: el equipo remoto sigue "
      "sin responder tras la accion correctiva.\n"
      "Host: %s\nTipo: %s\nFecha: %s\n"
      "Partes procesadas: %d de %s\nDetalle: %s\n"
      % (FILE_PREFIX, host, tipo, fecha, comandos_ok, total_partes, e),
    )
    print("[ERROR] (%s) SERVIDOR CAIDO: %s" % (fecha, e), file=sys.stderr)
    raise
  except Exception as e:
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


# Patrones que se esperan del CLI remoto (prompt de password y prompt '> ').
# Global de modulo: lo usa EXPECT().
buscar = ['Password: ', '> ']


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


def _procesar_lista(tipo, ids, host, aplicar_calendario):
  """Procesa una lista de 'ids' (fechas en modo dia a dia, o un unico label en
  modo snapshot). Cada id se usa para nombrar los CSV/checkpoints. Un id que
  falla por causa propia no detiene a los demas; un servidor caido tras la
  recuperacion aborta los restantes. Devuelve el codigo de salida (0/1)."""
  ok = []
  fallidos = []
  omitidos = []
  no_intentados = []
  servidor_caido = False

  for i, ident in enumerate(ids):
    # El calendario (domingos/festivos) solo aplica al proceso por fecha, no a
    # un snapshot del full_sync (que no depende del dia de ejecucion).
    if aplicar_calendario:
      omitir, motivo = dia_a_omitir(ident)
      if omitir:
        print("[OMITIDO] (%s) No se ejecuta: %s." % (ident, motivo))
        omitidos.append((ident, motivo))
        continue

    try:
      if procesar_dia(tipo, ident, host):
        ok.append(ident)
      else:
        # Fallo propio (ej. archivo inexistente): se continua con el resto.
        fallidos.append(ident)
    except ServidorCaidoError:
      # El servidor sigue caido tras la recuperacion: no tiene sentido seguir
      # intentando (y rebooteando) los restantes. Se aborta.
      servidor_caido = True
      fallidos.append(ident)
      no_intentados = ids[i + 1:]
      print("[ABORTAR] (%s) Servidor caido tras la recuperacion; se abortan los "
            "%d restante(s)." % (ident, len(no_intentados)), file=sys.stderr)
      if no_intentados:
        send_notification(
          "error",
          "[Portabilidad] ABORTADO %s" % tipo,
          "Se aborto porque el equipo remoto sigue caido tras la "
          "accion correctiva.\n"
          "Host: %s\nTipo: %s\nUltimo intentado: %s\n"
          "No intentados (%d): %s\n"
          "Reanuda cuando el equipo este disponible; los OK ya estan hechos y "
          "los pendientes conservan su checkpoint.\n"
          % (host, tipo, ident, len(no_intentados), ", ".join(no_intentados)),
        )
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
  portabilidad de 'tipo' (PORTED/DELETED) en uno de dos modos:

    - Modo FECHA (dia a dia): pasa date o date_from/date_to. Los CSV se llaman
      <PREFIX>_<TYPE>_<fecha>.csv y se omiten domingos/festivos (calendario).
    - Modo SNAPSHOT (full_sync): pasa label (o nada). El CSV se llama
      <PREFIX>_<TYPE>[_<label>].csv y NO se aplica calendario (un snapshot del
      estado total no depende del dia de ejecucion).

  No se pueden mezclar los dos modos. Devuelve el codigo de salida (0 = OK;
  1 = hubo fallos o se aborto). No llama a sys.exit(): el llamador decide."""
  # Valida que toda la configuracion obligatoria provenga del .env antes de operar.
  validar_configuracion()
  host = socket.gethostname()

  modo_fecha = bool(date or date_from or date_to)
  if modo_fecha and label is not None:
    raise ValueError("Usa el modo fecha (date/date-from/date-to) O el modo "
                     "snapshot (label), no ambos.")

  if modo_fecha:
    ids = resolver_fechas(date=date, date_from=date_from, date_to=date_to)
    return _procesar_lista(tipo, ids, host, aplicar_calendario=True)

  # Modo snapshot: un unico "id" que es el label (o cadena vacia => <PREFIX>_<TYPE>.csv).
  ident = (label or "").strip()
  return _procesar_lista(tipo, [ident], host, aplicar_calendario=False)


def main(argv=None):
  """Punto de entrada del CLI. Dos modos, mutuamente excluyentes:
    Dia a dia (portabilidad por fecha):
      --date YYYYMMDD                      -> un solo dia
      --date-from YYYYMMDD --date-to YYYYMMDD -> un rango, dia a dia
    Snapshot (diferencias del full_sync, sin fecha):
      --label ETIQUETA  (o sin argumento)  -> <PREFIX>_<TYPE>[_<label>].csv
  """
  parser = argparse.ArgumentParser(description='Portabilidad Process')
  parser.add_argument('--type', type=str, required=True, help='PORTED/DELETED')
  parser.add_argument('--date', type=str, help='Fecha unica a procesar (YYYYMMDD)')
  parser.add_argument('--date-from', dest='date_from', type=str,
                      help='Inicio del rango de fechas a procesar (YYYYMMDD)')
  parser.add_argument('--date-to', dest='date_to', type=str,
                      help='Fin del rango de fechas a procesar (YYYYMMDD), inclusive')
  parser.add_argument('--label', type=str,
                      help='Etiqueta opcional para el snapshot (sin fecha). '
                           'Nombra el CSV como <PREFIX>_<TYPE>[_<label>].csv.')

  args = parser.parse_args(argv)

  try:
    return run(args.type, date=args.date, date_from=args.date_from,
               date_to=args.date_to, label=args.label)
  except ValueError as e:
    print("[ERROR] %s" % e, file=sys.stderr)
    return 2


if __name__ == "__main__":
  sys.exit(main())
