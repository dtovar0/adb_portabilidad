import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // El cliente Prisma es externo al bundle del server (usa binarios nativos).
  serverExternalPackages: ["@prisma/client", "prisma"],
  // Alias "@/..." definido aqui (no en tsconfig) porque el TS mas reciente
  // elimino baseUrl, y sin baseUrl el resolver de webpack de Next no toma los
  // paths del tsconfig. Definirlo en webpack lo hace robusto a la version de TS.
  webpack(config) {
    config.resolve.alias["@"] = join(__dirname, "src");
    return config;
  },
};

export default nextConfig;
