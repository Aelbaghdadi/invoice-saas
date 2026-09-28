/**
 * Deteccion de posibles duplicados (F-010). Compara lo guardado con lo
 * guardado: el CIF limpio (parseTaxId(...).clean, sin prefijo de pais ni
 * separadores) y el numero de factura normalizado. Antes se comparaba el CIF
 * crudo del OCR («ESB12345678», «B-12345678») con el limpio de la BD y el
 * numero literal, y no casaban.
 */
import { Prisma, type InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatEur } from "@/lib/format";
import { formatDateEs } from "@/lib/dates";
import { periodLabel } from "@/lib/period";
import { normalizeBusinessName, parseTaxId } from "@/lib/validators";

/** «F-001», «F 001», «f001» y «F/001» son el mismo numero: sin espacios ni
 *  separadores y en mayusculas. Solo ASCII y en este orden (quitar y luego
 *  subir), igual que normalizedNumberSql: con toUpperCase primero, «ß» pasa
 *  a «SS» en JS y no en Postgres, y los dos lados no casaban.
 *
 *  Decisiones que se dejan asi a proposito:
 *   - Al quitar separadores, «2026-1-15» y «2026-11-5» dan lo mismo
 *     («2026115»). Es raro y solo pide una confirmacion; lo contrario (que
 *     «F-001» y «F 001» no casen) era el fallo de F-010.
 *   - Los ceros a la izquierda cuentan: «0042» no es «42». Hay series que
 *     los usan para distinguir numeros, y quitarlos juntaria facturas
 *     distintas. */
export function normalizeInvoiceNumber(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** normalizeInvoiceNumber en Postgres, sobre una columna o expresion. */
export function normalizedNumberSql(expression: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`upper(regexp_replace(${expression}, '[^A-Za-z0-9]', '', 'g'))`;
}

/**
 * La primera factura del cliente (no rechazada ni dividida, distinta de excludeId) con
 * el mismo numero normalizado y, en compras, el mismo CIF de emisor limpio.
 * En ventas basta el numero: el cliente y el tipo fijan al emisor. Una
 * compra sin CIF no se compara: el «1234» de un ticket sin NIF casaba con el
 * «1234» de cualquier otro proveedor.
 * El numero se normaliza igual en Postgres que en normalizeInvoiceNumber.
 */
export async function findByInvoiceNumber(input: {
  clientId: string;
  type: InvoiceType;
  excludeId: string;
  invoiceNumber: string;
  /** CIF del emisor limpio. En ventas se ignora. */
  issuerCif: string | null;
  /** Fecha de la factura que se comprueba. Con fecha, solo casa con otras
   *  del mismo año o sin fecha: un autonomo que numera «1», «2»… y reinicia
   *  cada año daba duplicados de un año para otro. */
  invoiceDate?: Date | null;
  /** Solo las ya validadas o exportadas (la comprobacion al validar). */
  onlyValidated?: boolean;
}): Promise<string | null> {
  const normalized = normalizeInvoiceNumber(input.invoiceNumber);
  if (!normalized) return null;
  const issuerCif = input.type === "SALE" ? null : input.issuerCif;
  if (input.type !== "SALE" && !issuerCif) return null;
  const onlyValidated = input.onlyValidated === true;
  const year = input.invoiceDate && !isNaN(input.invoiceDate.getTime()) ? input.invoiceDate.getUTCFullYear() : null;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Invoice"
    WHERE "clientId" = ${input.clientId}
      AND type = ${input.type}::"InvoiceType"
      AND id <> ${input.excludeId}
      AND status NOT IN ('REJECTED', 'SPLIT_SOURCE')
      AND (NOT ${onlyValidated} OR status IN ('VALIDATED', 'EXPORTED'))
      AND (${issuerCif}::text IS NULL OR "issuerCif" = ${issuerCif})
      AND (${year}::int IS NULL OR "invoiceDate" IS NULL OR extract(year FROM "invoiceDate") = ${year}::int)
      AND ${normalizedNumberSql(Prisma.raw('"invoiceNumber"'))} = ${normalized}
    ORDER BY "createdAt"
    LIMIT 1`;
  return rows[0]?.id ?? null;
}

export const DUPLICATE_SELECT = {
  id: true,
  invoiceNumber: true,
  filename: true,
  createdAt: true,
  periodType: true,
  periodMonth: true,
  periodYear: true,
} as const;

/** La factura ya registrada en el aviso de duplicado: numero, fecha de subida
 *  y periodo. Con el nombre del fichero a secas, si se subia el mismo PDF dos
 *  veces el aviso repetia el nombre del propio fichero y no decia cual era. */
export function describeExisting(existing: {
  invoiceNumber: string | null;
  filename: string;
  createdAt: Date;
  periodType: "MONTHLY" | "QUARTERLY";
  periodMonth: number;
  periodYear: number;
}): string {
  const ref = existing.invoiceNumber ?? `«${existing.filename}»`;
  const period = periodLabel(existing.periodType, existing.periodMonth, existing.periodYear);
  return `la factura ${ref} subida el ${formatDateEs(existing.createdAt)} (${period})`;
}

/** El `field` de una incidencia POSSIBLE_DUPLICATE guarda la factura original
 *  (sin migracion), para enlazarla desde la revision. */
const DUPLICATE_FIELD_PREFIX = "duplicateOf:";
export function duplicateField(originalId: string): string {
  return `${DUPLICATE_FIELD_PREFIX}${originalId}`;
}
export function duplicateOriginalId(field: string | null | undefined): string | null {
  return field?.startsWith(DUPLICATE_FIELD_PREFIX) ? field.slice(DUPLICATE_FIELD_PREFIX.length) : null;
}

export type DuplicateCheckInput = {
  /** La factura que se comprueba (queda fuera de la busqueda). */
  invoiceId: string;
  /** El cliente real (al clasificar, el elegido; no el buzon). */
  clientId: string;
  type: InvoiceType;
  invoiceNumber: string | null;
  /** Como se lean o se guarden: se limpian aqui. */
  issuerCif: string | null;
  receiverCif: string | null;
  receiverName: string | null;
  totalAmount: number | null;
  invoiceDate: string | Date | null;
  fileHash: string | null;
};

/**
 * Posible duplicado de una factura en su cliente, o null. Lo usan el OCR
 * (detectIssues) y la clasificacion manual, que antes solo miraba CIF +
 * numero y, en una venta sin NIF del destinatario, nada.
 *  0. El mismo fichero (hash): duplicado seguro.
 *  A. El numero normalizado y, en compras, el CIF del emisor limpio. En
 *     ventas basta el numero: el cliente y el tipo fijan al emisor. Con
 *     fecha, solo del mismo año (o sin fecha).
 *  B. Total y fecha: en compras con el CIF del emisor; en ventas con el
 *     destinatario, o sin NIF ni numero con su nombre normalizado.
 */
export async function findPossibleDuplicate(input: DuplicateCheckInput): Promise<{ description: string; originalId: string } | null> {
  const { invoiceId, clientId, type } = input;
  const isSale = type === "SALE";
  // Una original dividida (SPLIT_SOURCE) conserva numero, CIF, total y fecha:
  // sus hijas casaban con ella por A o por B. El hash si la mira: el mismo
  // fichero subido otra vez es un duplicado aunque ya se dividiera.
  const baseWhere = { clientId, type, id: { not: invoiceId }, status: { notIn: ["REJECTED" as const, "SPLIT_SOURCE" as const] } };
  const found = (existing: { id: string } & Parameters<typeof describeExisting>[0], reason: string) =>
    ({ description: `Posible duplicado de ${describeExisting(existing)}: ${reason}.`, originalId: existing.id });

  // 0. Mismo fichero (hash) ya subido a este cliente. La subida normal ya lo
  // frena, pero no la del buzon (aun sin cliente real) ni un ticket sin NIF,
  // numero ni nombre que las demas no pueden ver.
  if (input.fileHash) {
    const sameFile = await prisma.invoice.findFirst({
      where: { clientId, id: { not: invoiceId }, status: { notIn: ["REJECTED" as const] }, fileHash: input.fileHash },
      select: DUPLICATE_SELECT,
    });
    if (sameFile) return found(sameFile, "es el mismo fichero");
  }

  // CIF limpio, como se guarda (F-010).
  const issuerCif = parseTaxId(input.issuerCif).clean || null;

  // Protegemos la fecha: el OCR a veces devuelve un RANGO (facturas de
  // suministros, «14-jul-25 / 10-set-25») que da un Date invalido, y Prisma
  // lo rechazaba con un error crudo.
  const parsedDate = input.invoiceDate ? new Date(input.invoiceDate) : null;
  const validDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : null;

  // A. Numero normalizado (+ CIF del emisor en compras), del mismo año.
  if (input.invoiceNumber) {
    const dupId = await findByInvoiceNumber({
      clientId, type, excludeId: invoiceId, invoiceNumber: input.invoiceNumber, issuerCif, invoiceDate: validDate,
    });
    const dup = dupId ? await prisma.invoice.findUnique({ where: { id: dupId }, select: DUPLICATE_SELECT }) : null;
    if (dup) {
      return found(dup, isSale ? "mismo número de factura emitida" : `mismo número y mismo CIF emisor (${issuerCif})`);
    }
  }

  // B. Total y fecha.
  if (input.totalAmount == null || !validDate) return null;
  const sameAmountAndDate = { ...baseWhere, totalAmount: input.totalAmount, invoiceDate: validDate };
  const total = formatEur(input.totalAmount);

  if (!isSale) {
    if (!issuerCif) return null;
    const dup = await prisma.invoice.findFirst({ where: { ...sameAmountAndDate, issuerCif }, select: DUPLICATE_SELECT });
    return dup ? found(dup, `mismo CIF emisor (${issuerCif}), total (${total}) y fecha`) : null;
  }

  // En ventas el emisor es el propio cliente: se compara el destinatario,
  // limpio como se guarda (revision 2 del PR #7).
  const saleReceiver = parseTaxId(input.receiverCif).clean || null;
  if (saleReceiver) {
    const dup = await prisma.invoice.findFirst({ where: { ...sameAmountAndDate, receiverCif: saleReceiver }, select: DUPLICATE_SELECT });
    return dup ? found(dup, `mismo destinatario (${saleReceiver}), total (${total}) y fecha`) : null;
  }
  if (input.invoiceNumber) return null;
  // Venta sin NIF ni numero: solo con el nombre del destinatario, no vacio e
  // igual en las dos (normalizado). Por importe y fecha a secas, seis tickets
  // distintos de 1,50 € del mismo dia salian como duplicados.
  const name = normalizeBusinessName(input.receiverName ?? "");
  if (!name) return null;
  const candidates = await prisma.invoice.findMany({
    where: { ...sameAmountAndDate, receiverCif: null, receiverName: { not: null } },
    select: { ...DUPLICATE_SELECT, receiverName: true },
    take: 50,
  });
  const dup = candidates.find((c) => normalizeBusinessName(c.receiverName ?? "") === name);
  return dup
    ? found(dup, `venta sin NIF al mismo destinatario (${input.receiverName}), con el mismo total (${total}) y fecha`)
    : null;
}
