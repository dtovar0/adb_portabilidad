// Copia el schema.prisma del backend al frontend, respetando DB_PROVIDER, para
// que ambos paquetes generen el cliente contra el MISMO modelo sin duplicarlo a
// mano. Fuente unica de verdad: backend/prisma/schema.prisma.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "backend", "prisma", "schema.prisma");
const dst = join(here, "..", "prisma", "schema.prisma");

let schema = readFileSync(src, "utf8");
const provider = (process.env.DB_PROVIDER || "postgresql").trim();
if (provider === "postgresql" || provider === "mysql") {
  schema = schema.replace(/provider = "(postgresql|mysql)"/, `provider = "${provider}"`);
}
writeFileSync(dst, schema);
console.log(`[sync-schema] schema copiado del backend (provider=${provider}).`);
