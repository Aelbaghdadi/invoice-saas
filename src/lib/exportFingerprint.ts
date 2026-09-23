/**
 * Huella de lo que una factura manda al Excel de A3.
 *
 * Corregir una factura ya exportada no sirve de nada si el cambio no llega a
 * la contabilidad: A3 se quedaria con los datos viejos y nadie lo sabria. Con
 * esta huella se compara el antes y el despues de guardar en revision, y si
 * cambia algo que viaja al fichero, la factura se desmarca como exportada
 * para que entre en la siguiente exportacion.
 *
 * Solo entra lo que acaba en el fichero (columnas A-P de buildA3Row) mas lo
 * que decide si la factura se exporta o no (total a cero, moneda). Tocar un
 * campo interno que A3 no ve no obliga a reexportar: si no, cualquier
 * retoque en la revision sacaria la factura otra vez en el Excel.
 */

type FingerprintLine = {
  taxBase: unknown;
  vatRate: unknown;
  vatAmount: unknown;
  equivalenceSurchargeRate?: unknown;
  equivalenceSurchargeAmount?: unknown;
};

export type FingerprintInvoice = {
  type?: unknown;
  invoiceDate?: unknown;
  invoiceNumber?: unknown;
  issuerName?: unknown;
  issuerCif?: unknown;
  issuerCountry?: unknown;
  receiverName?: unknown;
  receiverCif?: unknown;
  receiverCountry?: unknown;
  operationType?: unknown;
  supplierAccount?: unknown;
  expenseAccount?: unknown;
  taxBase?: unknown;
  vatRate?: unknown;
  vatAmount?: unknown;
  irpfRate?: unknown;
  irpfAmount?: unknown;
  totalAmount?: unknown;
  currency?: unknown;
  isRectificative?: unknown;
  rectifiedInvoiceSeries?: unknown;
  rectifiedInvoiceNumber?: unknown;
  rectificativeType?: unknown;
  art80Tres?: unknown;
  vatLines?: FingerprintLine[] | null;
};

/** Decimal de Prisma, number, string o null acaban en el mismo texto: si no,
 *  leer la factura de BD y leerla del formulario darian huellas distintas
 *  sin que haya cambiado nada. */
function norm(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "1" : "0";
  const num = typeof value === "number" ? value : Number(String(value));
  if (!isNaN(num) && String(value).trim() !== "") return num.toFixed(2);
  return String(value).trim();
}

/** Los importes de una linea, en el orden en que salen en el Excel. */
function lineFingerprint(line: FingerprintLine): string {
  return [
    norm(line.taxBase),
    norm(line.vatRate),
    norm(line.vatAmount),
    norm(line.equivalenceSurchargeRate),
    norm(line.equivalenceSurchargeAmount),
  ].join(",");
}

export function exportFingerprint(invoice: FingerprintInvoice): string {
  const cabecera = [
    invoice.type,
    invoice.invoiceDate,
    invoice.invoiceNumber,
    invoice.issuerName,
    invoice.issuerCif,
    invoice.issuerCountry,
    invoice.receiverName,
    invoice.receiverCif,
    invoice.receiverCountry,
    invoice.operationType,
    invoice.supplierAccount,
    invoice.expenseAccount,
    // Base/tipo/cuota planos: en una factura sin desglose son los que el
    // exportador usa para montar la unica fila (datos legacy).
    invoice.taxBase,
    invoice.vatRate,
    invoice.vatAmount,
    invoice.irpfRate,
    invoice.irpfAmount,
    invoice.totalAmount,
    invoice.currency,
    invoice.isRectificative,
    invoice.rectifiedInvoiceSeries,
    invoice.rectifiedInvoiceNumber,
    invoice.rectificativeType,
    invoice.art80Tres,
  ].map(norm).join("|");

  // El orden de las lineas no cambia lo que A3 contabiliza (una fila por
  // tipo de IVA), asi que se ordenan antes de comparar: reordenarlas en la
  // revision no deberia obligar a reexportar.
  const lineas = (invoice.vatLines ?? []).map(lineFingerprint).sort().join(";");

  return `${cabecera}||${lineas}`;
}
