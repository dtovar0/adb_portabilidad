// Carga de variables de entorno compartidas.
//
// El backend reutiliza el .env de la RAIZ del repo (donde viven las credenciales
// ABD/PSX que ya usan los scripts Python) y ademas admite un backend/.env propio
// para lo especifico del backend (DB_PROVIDER, DATABASE_URL, ...). Se cargan
// ambos: la raiz primero y luego backend/.env, que puede sobreescribir.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // .../backend/src
const backendDir = dirname(here); // .../backend
const repoRoot = dirname(backendDir); // .../portabilidad

// override:false -> lo ya definido en el entorno real gana sobre los archivos.
config({ path: join(repoRoot, ".env"), override: false });
config({ path: join(backendDir, ".env"), override: false });

/** Devuelve una variable de entorno obligatoria o aborta con mensaje claro. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`[ENV] Falta la variable obligatoria: ${name}`);
    process.exit(2);
  }
  return v.trim();
}

/** Devuelve una variable opcional con valor por defecto. */
export function env(name: string, def = ""): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : def;
}
