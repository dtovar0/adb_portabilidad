// Cliente Prisma singleton para scripts y API.
import "./env.js"; // carga ../.env (raiz) + backend/.env antes de instanciar
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
