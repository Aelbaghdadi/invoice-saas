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
 * La solución tiene dos partes:
 *  1. Si el NIF es basura (vacío, "00000", "NIF"...), la clave se deriva del
 *     NOMBRE normalizado del tercero (`SINNIF:<NOMBRE>`).
 *  2. Si el NIF NO es basura, la clave es el NIF limpio, aunque no pase el
 *     algoritmo de control. Un NIF "no válido" pero con contenido sigue
 *     identificando al mismo tercero factura tras factura, y es la clave
 *     con la que ya están guardadas las 1.500+ filas del plan de cuentas
 *     (importadas de A3 y normalizadas sin prefijo de país). Tratarlo como
 *     "no fiable" mandaba a `SINNIF:` a proveedores reales cuyo NIF llega
 *     sin prefijo del OCR, y cada validación creaba una fila duplicada.
 *     Contra la colisión de dos terceros distintos con el mismo número
 *     (caso real: dos proveedores chinos con 418306763) está
 *     `entryNameMatches`, que los callers comprueban antes de autorrellenar
 *     o de sobreescribir la fila.
 */
import { normalizeBusinessName, parseTaxId } from "./validators";

/** Prefijo que marca una clave derivada del nombre (NIF no fiable). Sirve
 *  también para reconocer estas filas en la UI del plan de cuentas. */
export const NO_RELIABLE_NIF_PREFIX = "SINNIF:";

/** Quita espacios y separadores; no toca prefijos de país. */
function compact(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s.\-/]/g, "");
}

/**
 * ¿Es este NIF/VAT lo bastante fiable para usarlo como clave de identidad?
 *
 * "Fiable" aquí significa "no es basura": tiene contenido real que
 * identifica al tercero de forma estable. NO exige que pase el algoritmo de
 * control español: un VAT extranjero que llega sin prefijo (así se guardan
 * issuerCif/receiverCif) fallaría siempre ese algoritmo sin ser basura, y
 * un NIF español con la letra mal sigue siendo el mismo NIF en todas las
 * facturas de ese proveedor.
 *
 * `countryCode` es el país YA RESUELTO por parseTaxId en un paso anterior
 * (Invoice.issuerCountry/receiverCountry). Solo se usa para no volver a
 * recortar un prefijo de un NIF que ya viene limpio.
 */
export function isReliableNif(
  nif: string | null | undefined,
  countryCode?: string | null,
): boolean {
  if (!nif || !nif.trim()) return false;
  const clean = cleanKey(nif, countryCode);
  // Cabeceras de Excel importadas como datos ("NIF"), relleno ("00000") o
  // cualquier cosa demasiado corta para ser un identificador fiscal.
  if (clean.length < 5) return false;
  if (/^(.)\1*$/.test(clean)) return false;
  return true;
}

/**
 * NIF limpio para usar como clave. Con país extranjero conocido, el NIF ya
 * viene sin prefijo: recortar de nuevo con parseTaxId partiría un VAT cuyo
 * cuerpo empieza por dos letras (ej. un francés "FRAT123..." quedaría en
 * "123..." desde la factura y en "AT123..." desde el Excel, y no casarían).
 * Si aun así trae su propio prefijo (alta manual con "DE..."), se quita
 * solo ese.
 */
function cleanKey(rawNif: string, countryCode?: string | null): string {
  const value = compact(rawNif);
  if (countryCode && countryCode !== "ES") {
    return value.startsWith(countryCode) ? value.slice(countryCode.length) : value;
  }
  return parseTaxId(rawNif).clean || value;
}

/**
 * Clave de identidad de un tercero para AccountEntry: el NIF limpio si es
 * fiable, o `SINNIF:<NOMBRE NORMALIZADO>` si no lo es. Vacío ("") si no hay
 * ni NIF fiable ni nombre utilizable — en ese caso no se puede identificar
 * al tercero y no debe crearse/buscarse ninguna entrada.
 *
 * Una clave `SINNIF:` que vuelve a entrar (p.ej. al editar esa fila desde el
 * plan de cuentas) se conserva tal cual: pasarla por parseTaxId leía "SI"
 * como prefijo de Eslovenia y la rompía.
 */
export function accountEntryKey(
  rawNif: string | null | undefined,
  name: string | null | undefined,
  countryCode?: string | null,
): string {
  const raw = (rawNif ?? "").trim().toUpperCase();
  if (raw.startsWith(NO_RELIABLE_NIF_PREFIX)) return raw;
  if (isReliableNif(raw, countryCode)) return cleanKey(raw, countryCode);
  const normalizedName = normalizeBusinessName(name ?? "");
  return normalizedName ? `${NO_RELIABLE_NIF_PREFIX}${normalizedName}` : "";
}

/** Formas jurídicas y siglas que no identifican al tercero: "Bar Pepe SL"
 *  y "Bar Pepe, S.L." son la misma empresa. */
const LEGAL_FORM_TOKENS = new Set([
  "SL", "SA", "SLU", "SAU", "SLL", "SLP", "SCP", "SC", "CB", "SAT",
  "LTD", "LTDA", "LDA", "LLC", "LLP", "INC", "CO", "CORP", "PLC", "LP",
  "GMBH", "AG", "UG", "KG", "BV", "NV", "AS", "AB", "OY", "APS",
  "SRL", "SPA", "SAS", "SARL", "EURL", "SNC", "PTE", "PTY",
]);

/** Nombre reducido a lo que identifica al tercero: sin tildes, signos,
 *  formas jurídicas ni letras sueltas (la "S L" de "S.L."). */
export function normalizeThirdPartyName(raw: string | null | undefined): string {
  return normalizeBusinessName(raw ?? "")
    .split(" ")
    .filter((token) => token.length > 1 && !LEGAL_FORM_TOKENS.has(token))
    .join(" ");
}

/**
 * ¿Pueden ser el mismo tercero? Igualdad tras normalizar, o uno empieza por
 * el otro ("ACME" frente a "ACME DISTRIBUCION"). Sin nombre en alguno de los
 * dos lados no hay contradicción posible y se da por compatible.
 */
export function sameThirdParty(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const x = normalizeThirdPartyName(a);
  const y = normalizeThirdPartyName(b);
  if (!x || !y) return true;
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);
}

/**
 * ¿La fila del plan de cuentas encontrada por NIF es de verdad este tercero?
 *
 * Dos proveedores distintos pueden compartir número (caso real: "GUANGZHOU
 * BLINGS BAG" y "GUANGZHOU HONGXIN COSMETICS", ambos 418306763). Antes de
 * autorrellenar la cuenta de la fila, o de sobreescribirla al aprender, hay
 * que comprobar que el nombre encaja. Una fila aprendida sin nombre real
 * (name == nif) no puede contradecir a nadie.
 */
export function entryNameMatches(
  entry: { nif: string; name: string | null },
  invoiceName: string | null | undefined,
): boolean {
  if (!entry.name || entry.name === entry.nif) return true;
  return sameThirdParty(entry.name, invoiceName);
}
