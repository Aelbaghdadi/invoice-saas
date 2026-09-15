/**
 * Identidad de tercero (proveedor/cliente) para el plan de cuentas (AccountEntry).
 *
 * AccountEntry guarda una fila por (clientId, nif) y ese NIF es la clave que
 * usamos para encontrar/aprender la cuenta contable de cada tercero. El
 * problema: algunos proveedores extranjeros (habitual en proveedores chinos,
 * ej. "GUANGZHOU BLINGS BAG") no tienen un NIF/VAT fiable — vienen vacíos, o
 * con identificadores que no pasan ninguna validación. Usar ese valor tal
 * cual como clave es peligroso: si DOS proveedores distintos comparten el
 * mismo identificador basura, la fila del plan de cuentas de uno se
 * sobreescribiría con la del otro (se "fusionarían" como si fueran el mismo).
 *
 * La solución: cuando el NIF no es fiable, la clave se deriva del NOMBRE
 * normalizado del tercero en vez del NIF. Dos proveedores con nombres
 * distintos nunca colisionan aunque compartan el mismo NIF basura; el mismo
 * proveedor (mismo nombre) sigue encontrando/actualizando su misma fila.
 */
import { isValidTaxIdWithPrefix, normalizeBusinessName, parseTaxId } from "./validators";

/** Prefijo que marca una clave derivada del nombre (NIF no fiable). Sirve
 *  también para reconocer estas filas en la UI del plan de cuentas. */
export const NO_RELIABLE_NIF_PREFIX = "SINNIF:";

/**
 * ¿Es este NIF/VAT lo bastante fiable para usarlo como clave de identidad?
 *
 * `countryCode` es el país YA RESUELTO por parseTaxId en un paso anterior
 * (Invoice.issuerCountry/receiverCountry): el NIF que llega aquí normalmente
 * ya viene LIMPIO, sin el prefijo de país (p.ej. "812871812", no
 * "DE812871812"), porque así es como se guarda en Invoice. Sin ese contexto,
 * un NIF alemán limpio se intentaría validar como si fuera español y
 * fallaría el dígito de control — se marcaría "no fiable" por error incluso
 * siendo un VAT extranjero perfectamente real.
 *
 * Nacional (sin countryCode o "ES"): pasa el algoritmo de control completo.
 * Extranjero (countryCode conocido y distinto de "ES"): formato plausible
 * (no hay forma de verificar el dígito de control sin consultar VIES, pero
 * al menos no está vacío/es basura).
 */
export function isReliableNif(
  nif: string | null | undefined,
  countryCode?: string | null,
): boolean {
  if (!nif || !nif.trim()) return false;
  if (countryCode && countryCode !== "ES") {
    return /^[0-9A-Z]{2,12}$/.test(nif.trim().toUpperCase());
  }
  return isValidTaxIdWithPrefix(nif);
}

/**
 * Clave de identidad de un tercero para AccountEntry: el NIF limpio si es
 * fiable, o `SINNIF:<NOMBRE NORMALIZADO>` si no lo es. Vacío ("") si no hay
 * ni NIF fiable ni nombre utilizable — en ese caso no se puede identificar
 * al tercero y no debe crearse/buscarse ninguna entrada.
 *
 * `countryCode`: pásalo siempre que lo tengas (Invoice.issuerCountry /
 * receiverCountry, o parseTaxId(...).countryCode si el NIF crudo aún trae
 * el prefijo) — ver `isReliableNif`.
 */
export function accountEntryKey(
  rawNif: string | null | undefined,
  name: string | null | undefined,
  countryCode?: string | null,
): string {
  if (isReliableNif(rawNif, countryCode)) {
    return parseTaxId(rawNif!).clean || rawNif!.trim().toUpperCase();
  }
  const normalizedName = normalizeBusinessName(name ?? "");
  return normalizedName ? `${NO_RELIABLE_NIF_PREFIX}${normalizedName}` : "";
}
