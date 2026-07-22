// Lectura por streaming de las bases fuente (ABD/MSSQL y PSX/Oracle).
//
// Replica exactamente las queries de utils/full_sync.py:
//   - ABD: SELECT Number, CarrierRecipientId FROM [db].[dbo].[Portability] (NOLOCK)
//          WHERE FinalPortDate >= GETDATE()   (solo portaciones vigentes/futuras)
//   - PSX: SELECT NATIONAL_ID, TRANSLATED_NATIONAL_ID FROM NUMBER_TRANSLATION_DATA
//          operador = primeros 3 caracteres de TRANSLATED_NATIONAL_ID
//
// Cada fuente entrega un async iterator de {number, operator} para no cargar
// decenas de millones de filas en memoria.
import { env, requireEnv } from "./env.js";

export type Row = { number: string; operator: string };

/** Stream de la BD ABD (MSSQL) via el driver `mssql`. Solo vigentes/futuras. */
export async function* streamAbd(): AsyncGenerator<Row> {
  const sql = (await import("mssql")).default;
  const server = requireEnv("ABD_SERVER");
  const database = requireEnv("ABD_DATABASE");
  const encrypt = env("ABD_ENCRYPT", "no").toLowerCase() === "yes";

  const pool = await sql.connect({
    server,
    database,
    user: requireEnv("ABD_USER"),
    password: requireEnv("ABD_PASSWORD"),
    options: { encrypt, trustServerCertificate: true },
  });

  try {
    const request = new sql.Request(pool);
    request.stream = true;
    const query =
      `SELECT Number, CarrierRecipientId AS Operador ` +
      `FROM [${database}].[dbo].[Portability] (NOLOCK) ` +
      `WHERE FinalPortDate >= GETDATE()`;

    // Puente stream de eventos -> async generator con back-pressure simple.
    const queue: Row[] = [];
    let done = false;
    let err: unknown = null;
    let resume: (() => void) | null = null;
    const wake = () => {
      if (resume) {
        const r = resume;
        resume = null;
        r();
      }
    };

    request.on("row", (row: any) => {
      queue.push({ number: String(row.Number), operator: String(row.Operador) });
      wake();
    });
    request.on("error", (e: unknown) => {
      err = e;
      wake();
    });
    request.on("done", () => {
      done = true;
      wake();
    });
    request.query(query);

    while (true) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (err) throw err;
      if (done) break;
      await new Promise<void>((r) => (resume = r));
    }
  } finally {
    await pool.close();
  }
}

/** Stream de la BD PSX (Oracle) via `oracledb`. Operador = 3 primeros chars. */
export async function* streamPsx(): AsyncGenerator<Row> {
  const oracledb = (await import("oracledb")).default;
  const connection = await oracledb.getConnection({
    user: requireEnv("PSX_USER"),
    password: requireEnv("PSX_PASSWORD"),
    connectString: `${requireEnv("PSX_HOST")}:${env("PSX_PORT", "1521")}/${requireEnv("PSX_SID")}`,
  });

  try {
    const result = await connection.execute<[string, string]>(
      `select NATIONAL_ID, TRANSLATED_NATIONAL_ID from NUMBER_TRANSLATION_DATA`,
      [],
      { resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY }
    );
    const rs = result.resultSet!;
    let row: any;
    while ((row = await rs.getRow())) {
      const nationalId = String(row[0]);
      const translated = row[1] == null ? "" : String(row[1]);
      // Formato invalido: no se puede derivar operador (3 primeros chars).
      if (translated.length < 3) continue;
      yield { number: nationalId, operator: translated.slice(0, 3) };
    }
    await rs.close();
  } finally {
    await connection.close();
  }
}

export function streamSource(source: "abd" | "psx"): AsyncGenerator<Row> {
  return source === "abd" ? streamAbd() : streamPsx();
}
