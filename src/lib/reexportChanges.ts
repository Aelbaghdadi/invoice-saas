import { exportedColumns, type ExportedColumn, type FingerprintInvoice } from "@/lib/exportFingerprint";
import { formatAmountEs } from "@/lib/format";
import { formatDateEs, formatDateTimeEs } from "@/lib/dates";

/**
 * Que cambia en el Excel de A3 entre el ultimo lote en el que salio una
 * factura (el snapshot de ExportBatchItem) y como esta ahora (F-018).
 *
 * A3 no admite dos facturas con el mismo NIF y numero: quien exporta tiene
 * que saber cuales ya estan alli y que tiene que corregir o borrar. Se
 * compara lo mismo que la huella (exportedColumns), asi que una factura
 * reexportada siempre tiene al menos un cambio que ensenar.
 */

export type ExportChange = { field: string; before: string; after: string };

/** Una factura que vuelve al Excel tras corregirse despues de exportarse. */
export type Reexport = {
  invoiceId: string;
  /** Como esta en A3 (del ultimo Excel): el numero con «_R» en una
   *  rectificativa, y el de antes si se ha corregido. Es la que hay que
   *  buscar alli para borrarla o corregirla. */
  a3InvoiceNumber: string;
  a3Nif: string;
  a3Name: string;
  previousExportAt: Date;
  /** Quien la exporto la ultima vez; null si ese usuario ya no esta. */
  previousExportBy: string | null;
  /** null: el snapshot anterior no se puede leer. */
  changes: ExportChange[] | null;
};

export const REEXPORT_SHEET_NAME = "Reexportadas — revisar en A3";

const REEXPORT_SHEET_HEADERS = ["Nº factura en A3", "NIF en A3", "Nombre en A3", "Exportada antes el", "Exportada por", "Campo", "Antes", "Ahora"];

/**
 * Filas de la hoja de reexportadas: una por cambio, con los datos de la
 * factura repetidos para que se pueda filtrar en Excel.
 */
export function reexportSheetRows(reexports: Reexport[]): string[][] {
  const rows = [REEXPORT_SHEET_HEADERS];
  for (const r of reexports) {
    const invoice = [r.a3InvoiceNumber, r.a3Nif, r.a3Name, formatDateTimeEs(r.previousExportAt), r.previousExportBy ?? "—"];
    if (r.changes == null || r.changes.length === 0) {
      rows.push([...invoice, "—", "No se puede comparar con el Excel anterior", ""]);
      continue;
    }
    for (const c of r.changes) rows.push([...invoice, c.field, c.before, c.after]);
  }
  return rows;
}

const IMPORTES = new Set<ExportedColumn["key"]>(["irpfRate", "irpfAmount", "totalAmount"]);

function label(key: ExportedColumn["key"], isSale: boolean): string {
  switch (key) {
    case "type": return "Tipo";
    case "invoiceDate": return "Fecha";
    case "invoiceNumber": return "Nº factura";
    case "thirdPartyNif": return "NIF";
    case "thirdPartyName": return "Nombre";
    case "operationCode": return "Tipo de operación (código A3)";
    case "supplierAccount": return isSale ? "Cuenta de cliente" : "Cuenta de proveedor";
    case "expenseAccount": return isSale ? "Cuenta de ingreso" : "Cuenta de gasto";
    case "irpfRate": return "% IRPF";
    case "irpfAmount": return "Cuota IRPF";
    case "totalAmount": return "Total";
  }
}

function shown(key: ExportedColumn["key"], value: string): string {
  if (value === "") return "—";
  if (key === "type") return value === "SALE" ? "Emitida" : "Recibida";
  if (key === "invoiceDate") return formatDateEs(value);
  if (IMPORTES.has(key)) return formatAmountEs(value);
  return value;
}

/** «1.000,00 al 21 % (cuota 210,00)», con el recargo si lo hay. */
function shownLine(line: string): string {
  const [base, rate, amount, surchargeRate, surchargeAmount] = line.split(",");
  const recargo = Number(surchargeRate) !== 0 || Number(surchargeAmount) !== 0
    ? `, recargo ${formatAmountEs(surchargeRate)} % (${formatAmountEs(surchargeAmount)})`
    : "";
  return `${formatAmountEs(base)} al ${formatAmountEs(rate).replace(/,00$/, "")} % (cuota ${formatAmountEs(amount)}${recargo})`;
}

/** El snapshot de ExportBatchItem, o null si no se puede leer. */
function parseSnapshot(snapshot: string): FingerprintInvoice | null {
  try {
    const parsed: unknown = JSON.parse(snapshot);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as FingerprintInvoice;
  } catch {
    return null;
  }
}

/**
 * Numero, NIF y nombre con los que la factura esta en A3: los del ultimo
 * Excel, no los de ahora. Si se corrigio el numero (F-1 → F-1B), en A3 sigue
 * F-1. Sin snapshot legible, los actuales.
 */
export function a3Identity(snapshot: string, current: FingerprintInvoice): { invoiceNumber: string; nif: string; name: string } {
  const { header } = exportedColumns(parseSnapshot(snapshot) ?? current);
  const value = (key: ExportedColumn["key"]) => header.find((c) => c.key === key)!.value;
  return { invoiceNumber: value("invoiceNumber"), nif: value("thirdPartyNif"), name: value("thirdPartyName") };
}

/** null si el snapshot no se puede leer: no hay con que comparar. */
export function reexportChanges(snapshot: string, current: FingerprintInvoice): ExportChange[] | null {
  const before = parseSnapshot(snapshot);
  if (!before) return null;
  const old = exportedColumns(before);
  const now = exportedColumns(current);
  const isSale = now.header[0].value === "SALE";
  const changes: ExportChange[] = [];
  now.header.forEach((column, i) => {
    const previous = old.header[i].value;
    if (previous !== column.value) {
      changes.push({ field: label(column.key, isSale), before: shown(column.key, previous), after: shown(column.key, column.value) });
    }
  });
  if (old.lines.join(";") !== now.lines.join(";")) {
    changes.push({
      field: "Desglose de IVA",
      before: old.lines.map(shownLine).join(" · ") || "—",
      after: now.lines.map(shownLine).join(" · ") || "—",
    });
  }
  return changes;
}
