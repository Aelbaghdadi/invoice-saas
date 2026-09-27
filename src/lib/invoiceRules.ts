/**
 * Lo minimo que tiene que tener una factura para validarse (F-009, F-014).
 * Antes solo lo miraba la pantalla, y ni siquiera todo: el servidor validaba
 * sin total, fecha, numero ni lineas, y un descuadre tambien pasaba.
 *
 * Sin dependencias de Next ni de Prisma: lo usan la accion de validar, la
 * pantalla de revision (para avisar antes de enviar) y el export.
 */
import { isInvoiceBalanced } from "@/lib/invoiceBalance";
import { formatEur } from "@/lib/format";

export type RuleLine = {
  taxBase: number;
  vatAmount: number;
  equivalenceSurchargeAmount?: number | null;
};

export type RuleInvoice = {
  type: "PURCHASE" | "SALE";
  invoiceNumber: string | null;
  /** Date del servidor o el texto del <input type="date">: basta con que haya. */
  invoiceDate: Date | string | null;
  totalAmount: number | null;
  irpfAmount: number | null;
  lines: RuleLine[];
  isRectificative: boolean;
  /** NIF de la otra parte: el emisor en recibidas, el receptor en emitidas. */
  thirdPartyTaxId: string | null;
  operationType: string | null;
  supplierAccount: string | null;
  expenseAccount: string | null;
  /** Cuenta generica del cliente para simplificadas y tickets
   *  (Client.simplifiedSupplierAccount), o null si no tiene. */
  simplifiedSupplierAccount: string | null;
};

export type RuleCode =
  | "sin_total"
  | "sin_fecha"
  | "sin_numero"
  | "sin_lineas"
  | "sin_cuentas"
  | "sin_nif"
  | "descuadre";

export type RuleProblem = { rule: RuleCode; message: string };

/** Operaciones nacionales: el tercero tiene NIF espanol sin discusion. En
 *  las demas (intracomunitarias, importaciones, inversion del sujeto pasivo)
 *  puede ser un proveedor extranjero sin NIF espanol: no se bloquea. */
const DOMESTIC_OPERATION_TYPES = new Set(["INTERIOR", "AGRARIA", "IVA_NO_DEDUCIBLE"]);

const blank = (v: string | null | undefined) => !v || v.trim() === "";

/** ¿Va con la cuenta generica de simplificadas / tickets? Es lo que pone el
 *  boton «Usar cuenta genérica» de la revision. */
export function usesSimplifiedAccount(inv: Pick<RuleInvoice, "supplierAccount" | "simplifiedSupplierAccount">): boolean {
  return !blank(inv.simplifiedSupplierAccount)
    && !blank(inv.supplierAccount)
    && inv.supplierAccount!.trim() === inv.simplifiedSupplierAccount!.trim();
}

/** ¿Hace falta el NIF de la otra parte? Si, salvo en simplificadas y tickets
 *  con la cuenta generica, y en operaciones que no son nacionales. */
export function thirdPartyTaxIdRequired(
  inv: Pick<RuleInvoice, "operationType" | "supplierAccount" | "simplifiedSupplierAccount">,
): boolean {
  if (usesSimplifiedAccount(inv)) return false;
  return DOMESTIC_OPERATION_TYPES.has(inv.operationType ?? "INTERIOR");
}

/**
 * Datos sin los que la factura no se puede contabilizar: total, fecha,
 * numero, alguna linea con base, cuentas y NIF del tercero. En orden de
 * pantalla, de arriba abajo.
 */
export function missingDataProblems(inv: RuleInvoice): RuleProblem[] {
  const problems: RuleProblem[] = [];
  const isPurchase = inv.type === "PURCHASE";
  if (thirdPartyTaxIdRequired(inv) && blank(inv.thirdPartyTaxId)) {
    problems.push({
      rule: "sin_nif",
      message: `Falta el NIF del ${isPurchase ? "proveedor" : "destinatario"}. Si es un ticket o una factura simplificada, usa la cuenta genérica del cliente.`,
    });
  }
  if (blank(inv.invoiceNumber)) problems.push({ rule: "sin_numero", message: "Falta el número de factura." });
  if (!inv.invoiceDate || (typeof inv.invoiceDate === "string" && inv.invoiceDate.trim() === "")) {
    problems.push({ rule: "sin_fecha", message: "Falta la fecha de la factura." });
  }
  // Una rectificativa puede ir entera a cero (corrige otros datos): basta con
  // que tenga su linea. Las demas necesitan alguna base distinta de 0.
  const hasLines = inv.isRectificative
    ? inv.lines.length > 0
    : inv.lines.some((l) => Math.abs(l.taxBase) >= 0.005);
  if (!hasLines) {
    problems.push({ rule: "sin_lineas", message: "Falta al menos una línea de IVA con base distinta de 0." });
  }
  if (inv.totalAmount === null || Number.isNaN(inv.totalAmount)) {
    problems.push({ rule: "sin_total", message: "Falta el total de la factura." });
  }
  if (blank(inv.supplierAccount) || blank(inv.expenseAccount)) {
    problems.push({ rule: "sin_cuentas", message: "Faltan cuentas contables: rellénalas antes de validar." });
  }
  return problems;
}

/** Descuadre con la tolerancia comun (F-058), o null. Sin total o sin lineas
 *  no se calcula: eso ya lo dice missingDataProblems. */
export function balanceProblem(inv: Pick<RuleInvoice, "lines" | "totalAmount" | "irpfAmount">): RuleProblem | null {
  if (inv.totalAmount === null || Number.isNaN(inv.totalAmount) || inv.lines.length === 0) return null;
  const balance = {
    sumBase: inv.lines.reduce((s, l) => s + l.taxBase, 0),
    sumAmount: inv.lines.reduce((s, l) => s + l.vatAmount, 0),
    sumSurcharge: inv.lines.reduce((s, l) => s + (l.equivalenceSurchargeAmount ?? 0), 0),
    irpf: inv.irpfAmount ?? 0,
    total: inv.totalAmount,
  };
  if (isInvoiceBalanced(balance)) return null;
  const expected = balance.sumBase + balance.sumAmount + balance.sumSurcharge - balance.irpf;
  return {
    rule: "descuadre",
    message: `El importe no cuadra: las líneas suman ${formatEur(expected)} y el total es ${formatEur(inv.totalAmount)}.`,
  };
}

/** Todo lo que impide validar, en orden. Vacio si se puede. */
export function validationProblems(inv: RuleInvoice): RuleProblem[] {
  const problems = missingDataProblems(inv);
  const balance = balanceProblem(inv);
  if (balance) problems.push(balance);
  return problems;
}
