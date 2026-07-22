// Sincroniza el `provider` del datasource en schema.prisma con DB_PROVIDER.
//
// Prisma no admite env() en el provider (debe ser literal). Este script reescribe
// la linea `provider = "..."` del bloque datasource segun DB_PROVIDER ("postgresql"
// o "mysql"). Se corre automaticamente antes de db:generate / db:migrate / db:push.
import "../src/env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "prisma", "schema.prisma");

const provider = (process.env.DB_PROVIDER || "postgresql").trim();
const allowed = new Set(["postgresql", "mysql"]);
if (!allowed.has(provider)) {
  console.error(
    `[set-provider] DB_PROVIDER invalido: "${provider}". Usa "postgresql" o "mysql".`
  );
  process.exit(2);
}

const schema = readFileSync(schemaPath, "utf8");
// Reemplaza SOLO la primera linea `provider = "..."` (la del datasource; el
// generator usa provider = "prisma-client-js", que no matchea el patron de motor).
const updated = schema.replace(
  /provider = "(postgresql|mysql)"/,
  `provider = "${provider}"`
);

if (updated === schema) {
  console.log(`[set-provider] provider ya es "${provider}", sin cambios.`);
} else {
  writeFileSync(schemaPath, updated);
  console.log(`[set-provider] datasource.provider = "${provider}".`);
}
