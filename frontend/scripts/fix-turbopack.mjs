// Workaround de un bug de Next 15.5.x: Turbopack busca
// next/dist/lib/server-external-packages.jsonc pero el paquete solo trae el .json.
// Creamos el .jsonc como copia si falta. Se ejecuta en postinstall para que
// sobreviva a reinstalaciones. Cuando Next lo corrija, este script se vuelve no-op.
import { existsSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

try {
  const require = createRequire(import.meta.url);
  const nextPkg = require.resolve("next/package.json");
  const libDir = join(dirname(nextPkg), "dist", "lib");
  const json = join(libDir, "server-external-packages.json");
  const jsonc = join(libDir, "server-external-packages.jsonc");
  if (existsSync(json) && !existsSync(jsonc)) {
    copyFileSync(json, jsonc);
    console.log("[fix-turbopack] Creado server-external-packages.jsonc (workaround Next 15.5).");
  }
} catch (e) {
  console.warn("[fix-turbopack] No se pudo aplicar el workaround:", e?.message ?? e);
}
