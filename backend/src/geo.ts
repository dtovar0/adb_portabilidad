// Derivacion geografica de un numero mexicano de 10 digitos.
//
// Estructura del numero (Plan Tecnico Fundamental de Numeracion, IFT):
//   NIR (Numero Identificador de Region) + numero local, total 10 digitos.
//   - NIR de 2 digitos: SOLO zonas metropolitanas 55 (CDMX), 33 (Guadalajara)
//     y 81 (Monterrey).
//   - NIR de 3 digitos: el resto del pais.
// El estado se obtiene mapeando el NIR contra el catalogo del IFT
// (data/nir_estado.csv, cargado en la tabla nir_catalog).

/** NIRs de 2 digitos (unicas zonas metropolitanas con marcacion 2+8). */
const NIR2 = new Set(["55", "33", "81"]);

/**
 * Extrae el NIR (2 o 3 digitos) de un numero de 10 digitos.
 * Devuelve null si el numero no tiene 10 digitos numericos.
 */
export function nirFromNumber(num: string): string | null {
  const n = num.trim();
  if (!/^\d{10}$/.test(n)) return null;
  const two = n.slice(0, 2);
  if (NIR2.has(two)) return two;
  return n.slice(0, 3);
}

/** Mapa NIR -> {state, population} en memoria para lookups O(1) en la ingesta. */
export type NirMap = Map<string, { state: string; population: string | null }>;

/**
 * Resuelve el estado de un numero usando un NirMap ya cargado.
 * Devuelve {nir, state, municipality} con state/municipality en null si no mapea.
 */
export function resolveState(
  num: string,
  nirMap: NirMap
): { nir: string | null; state: string | null; municipality: string | null } {
  const nir = nirFromNumber(num);
  if (!nir) return { nir: null, state: null, municipality: null };
  const hit = nirMap.get(nir);
  if (!hit) return { nir, state: null, municipality: null };
  return { nir, state: hit.state, municipality: hit.population };
}
