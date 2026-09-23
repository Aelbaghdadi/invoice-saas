import { OPERATION_TYPE_CODE, taxIdWithCountry, type OperationTypeName } from "@/lib/validators";

/**
 * Huella de lo que una factura manda al Excel de A3.
 *
 * Corregir una factura ya exportada no sirve de nada si el cambio no llega a
 * la contabilidad: A3 se quedaria con los datos viejos y nadie lo sabria. Con
 * esta huella se compara lo que se exporto contra lo que se acaba de guardar
 * en revision; si difiere, la factura vuelve a la cola de exportacion.
 *
 * La huella reproduce las columnas de `buildA3Row` (exportFormats.ts), no los
 * campos crudos de la factura, porque lo que importa es si A3 va a ver algo
 * distinto:
 *  - El texto se compara LITERAL. Pasarlo por Number() hacia que "0023" y
 *    "23" fueran la misma huella, y corregir el numero de una factura no la
 *    sacaba otra vez (A3 empareja por NIF + numero, asi que se quedaba con el
 *    numero mal para siempre).
 *  - El NIF se compone con su pais igual que la columna E. En crudo, el
 *    vaiven de "ES" a null que hace el formulario al guardar desmarcaba la
 *    factura en cada guardado aunque la columna E fuera identica.
 *  - Lo que no viaja al fichero (moneda, datos de control de la
 *    rectificativa, la parte que es el propio cliente) no entra: sacaria la
 *    factura otra vez para escribir exactamente la misma fila.
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
  isRectificative?: unknown;
  vatLines?: FingerprintLine[] | null;
  /** El snapshot de ExportBatchItem trae mas campos de los que entran en la
   *  huella (moneda, datos de la rectificativa, la otra parte...). Se aceptan
   *  y se ignoran a proposito: lo que no viaja al fichero no cuenta. */
  [campo: string]: unknown;
};

/** Texto tal cual va a la celda. Sin recortar ni normalizar: un espacio de
 *  mas tambien viaja al fichero. */
function texto(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

/** Importe. Decimal de Prisma, number o string acaban igual: leer la factura
 *  de BD y leerla del formulario tienen que dar la misma huella. */
function importe(value: unknown): string {
  if (value == null || value === "") return "0.00";
  const num = typeof value === "number" ? value : Number(String(value));
  return isNaN(num) ? String(value) : num.toFixed(2);
}

/** Fecha en YYYY-MM-DD, venga como Date o como cadena. */
function fecha(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  const s = String(value);
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

/** Las lineas que emitiria el exportador: el desglose si lo hay y, si no, la
 *  linea unica sintetizada con los campos planos (igual que getExportLines).
 *  El recargo ausente y el recargo a cero son el mismo 0 en el fichero. */
function lineasExportadas(invoice: FingerprintInvoice): string[] {
  const lineas = invoice.vatLines && invoice.vatLines.length > 0
    ? invoice.vatLines
    : [{ taxBase: invoice.taxBase, vatRate: invoice.vatRate, vatAmount: invoice.vatAmount }];
  return lineas
    .map((l) => [
      importe(l.taxBase),
      importe(l.vatRate),
      importe(l.vatAmount),
      importe((l as FingerprintLine).equivalenceSurchargeRate),
      importe((l as FingerprintLine).equivalenceSurchargeAmount),
    ].join(","))
    // El orden de las filas no cambia lo que A3 contabiliza: se ordenan para
    // que reordenar el desglose en la revision no obligue a reexportar.
    .sort();
}

export function exportFingerprint(invoice: FingerprintInvoice): string {
  const isPurchase = texto(invoice.type) !== "SALE";
  // Columnas E y F: el tercero, que es el emisor en recibidas y el receptor
  // en emitidas. La otra parte es el propio cliente y no viaja al fichero.
  const terceroNif = taxIdWithCountry(
    texto(isPurchase ? invoice.issuerCif : invoice.receiverCif),
    texto(isPurchase ? invoice.issuerCountry : invoice.receiverCountry),
  );
  const terceroNombre = texto(isPurchase ? invoice.issuerName : invoice.receiverName);
  // Columnas C y D: el numero lleva el sufijo _R en las rectificativas.
  const numero = texto(invoice.invoiceNumber);
  const numeroExportado = invoice.isRectificative && numero ? `${numero}_R` : numero;
  // Columna G: el codigo que ve A3, no el nombre del tipo de operacion.
  const codigoOperacion = invoice.operationType
    ? OPERATION_TYPE_CODE[texto(invoice.operationType) as OperationTypeName] ?? 1
    : 1;

  const cabecera = [
    texto(invoice.type),
    fecha(invoice.invoiceDate),
    numeroExportado,
    terceroNif,
    terceroNombre,
    String(codigoOperacion),
    texto(invoice.supplierAccount),
    texto(invoice.expenseAccount),
    importe(invoice.irpfRate),
    importe(invoice.irpfAmount),
    // El total no es una columna, pero una factura con total cero se queda
    // fuera del fichero: si cambia, cambia lo que A3 recibe.
    importe(invoice.totalAmount),
  ].join("|");

  return `${cabecera}||${lineasExportadas(invoice).join(";")}`;
}
