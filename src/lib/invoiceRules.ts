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
import { isForeignCurrency } from "@/lib/currency";
import { padAccountingAccount, partyAccountMatchesType, resultAccountMatchesType } from "@/lib/accountingAccount";

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
  /** Pais del prefijo de ese NIF (parseTaxId), o null si no lleva. */
  thirdPartyCountry: string | null;
  operationType: string | null;
  supplierAccount: string | null;
  expenseAccount: string | null;
  /** Cuenta generica del cliente para simplificadas y tickets
   *  (Client.simplifiedSupplierAccount), o null si no tiene. */
  simplifiedSupplierAccount: string | null;
  /** ISO 4217; null se da por euros. */
  currency: string | null;
};

export type RuleCode =
  | "sin_total"
  | "sin_fecha"
  | "sin_numero"
  | "sin_lineas"
  | "sin_cuentas"
  | "sin_nif"
  | "sin_nif_iva"
  | "moneda"
  | "cuenta_sentido"
  | "descuadre";

export type RuleProblem = { rule: RuleCode; message: string };

/** Operaciones nacionales: el tercero tiene NIF espanol sin discusion. */
const DOMESTIC_OPERATION_TYPES = new Set(["INTERIOR", "AGRARIA", "IVA_NO_DEDUCIBLE"]);
/** Intracomunitarias: hace falta el NIF-IVA (con el prefijo del pais). Sin el
 *  no hay modelo 349 y A3 rechaza la fila («el NIF no existe en la tabla»).
 *  Decidido en el PR #7. En importaciones no se exige; en inversion del sujeto
 *  pasivo tampoco, pendiente de que lo confirme el asesor. */
const INTRACOM_OPERATION_TYPES = new Set(["INTRACOM", "INTRACOM_SERVICIOS"]);

const blank = (v: string | null | undefined) => !v || v.trim() === "";

/** ¿Va con la cuenta generica de simplificadas / tickets? Es lo que pone el
 *  boton «Usar cuenta genérica» de la revision. Se comparan completadas con
 *  padAccountingAccount: una generica antigua de 7 digitos dejaba de coincidir
 *  en cuanto el campo de la revision la completaba a 8. */
export function usesSimplifiedAccount(inv: Pick<RuleInvoice, "supplierAccount" | "simplifiedSupplierAccount">): boolean {
  if (blank(inv.simplifiedSupplierAccount) || blank(inv.supplierAccount)) return false;
  return padAccountingAccount(inv.supplierAccount!.trim()) === padAccountingAccount(inv.simplifiedSupplierAccount!.trim());
}

/** ¿Hace falta el NIF de la otra parte? Si, salvo en simplificadas y tickets
 *  con la cuenta generica, en ventas nacionales y en operaciones que no son
 *  nacionales ni intracomunitarias. */
export function thirdPartyTaxIdRequired(
  inv: Pick<RuleInvoice, "type" | "operationType" | "supplierAccount" | "simplifiedSupplierAccount">,
): boolean {
  // Una intracomunitaria no es un ticket: la cuenta generica no la exime.
  if (INTRACOM_OPERATION_TYPES.has(inv.operationType ?? "")) return true;
  // Ventas: la generica del cliente es de proveedor (4xx/6xx) y no hay una de
  // clientes, asi que una venta a un consumidor final sin NIF no tendria
  // salida. Hasta que exista (simplifiedCustomerAccount, con migracion), en
  // ventas nacionales el NIF que falta es un aviso (revision 1 del PR #7).
  if (inv.type === "SALE") return false;
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
  const party = isPurchase ? "proveedor" : "destinatario";
  const intracom = INTRACOM_OPERATION_TYPES.has(inv.operationType ?? "");
  if (intracom && blank(inv.thirdPartyTaxId)) {
    problems.push({
      rule: "sin_nif",
      message: `Falta el NIF-IVA del ${party}: en una operación intracomunitaria hace falta para el modelo 349 y para A3.`,
    });
  } else if (intracom && (blank(inv.thirdPartyCountry) || inv.thirdPartyCountry!.trim() === "ES")) {
    problems.push({
      rule: "sin_nif_iva",
      message: `El NIF del ${party} no lleva el prefijo del país: en una operación intracomunitaria hace falta el NIF-IVA (p. ej. PT515160873).`,
    });
  } else if (thirdPartyTaxIdRequired(inv) && blank(inv.thirdPartyTaxId)) {
    problems.push({
      rule: "sin_nif",
      message: blank(inv.simplifiedSupplierAccount)
        ? `Falta el NIF del ${party}. Si es un ticket o una factura simplificada, pide a un administrador que configure la cuenta genérica del cliente.`
        : `Falta el NIF del ${party}. Si es un ticket o una factura simplificada, usa la cuenta genérica del cliente.`,
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
    problems.push({
      rule: "sin_lineas",
      message: inv.isRectificative
        ? "Falta al menos una línea de IVA (en una rectificativa puede ir a 0)."
        : "Falta al menos una línea de IVA con base distinta de 0.",
    });
  }
  if (inv.totalAmount === null || Number.isNaN(inv.totalAmount)) {
    problems.push({ rule: "sin_total", message: "Falta el total de la factura." });
  }
  if (blank(inv.supplierAccount) || blank(inv.expenseAccount)) {
    problems.push({ rule: "sin_cuentas", message: "Faltan cuentas contables: rellénalas antes de validar." });
  }
  return problems;
}

/** Importes en otra moneda sin convertir (F-025): A3 los tomaria por euros.
 *  «Ya están en euros» en la revision la deja en EUR. */
export function currencyProblem(inv: Pick<RuleInvoice, "currency">): RuleProblem | null {
  if (!isForeignCurrency(inv.currency)) return null;
  return {
    rule: "moneda",
    message: `Los importes están en ${inv.currency}: A3 solo admite euros. Conviértelos a euros y pulsa «Ya están en euros» antes de validar.`,
  };
}

/** Cuentas de resultado del sentido contrario que el PGC usa para minorar
 *  (devoluciones, descuentos y rappels): 606/608/609 en una emitida (p. ej.
 *  el rappel que se factura al proveedor) y 706/708/709 en una recibida. */
const REDUCING_RESULT_ACCOUNT: Record<"PURCHASE" | "SALE", RegExp> = {
  SALE: /^60[689]/,
  PURCHASE: /^70[689]/,
};

/**
 * Cuentas del sentido contrario: una venta con cuenta de proveedor (40x/41x)
 * o de gasto (6xx), o una compra con cuenta de cliente (43x) o de ingreso
 * (7xx). Pasaba con una «No lo sé» abierta como recibida, con «Usar cuenta
 * genérica» (400/629) y cambiada despues a emitida (revision 2 del PR #7).
 * Las que minoran (REDUCING_RESULT_ACCOUNT) no cuentan como contrarias.
 */
export function accountDirectionProblem(
  inv: Pick<RuleInvoice, "type" | "supplierAccount" | "expenseAccount">,
): RuleProblem | null {
  const isSale = inv.type === "SALE";
  // Completadas, como se guardan: «4.1» (Ctrl+Enter sin salir del campo) no
  // empieza por 40 hasta que se completa a 40000001.
  const party = padAccountingAccount(inv.supplierAccount?.trim() ?? "");
  const result = padAccountingAccount(inv.expenseAccount?.trim() ?? "");
  if (party && !partyAccountMatchesType(party, inv.type)) {
    return {
      rule: "cuenta_sentido",
      message: isSale
        ? `La cuenta ${party} es de proveedor y esta factura es emitida: usa una cuenta de cliente (43x).`
        : `La cuenta ${party} es de cliente y esta factura es recibida: usa una cuenta de proveedor (40x o 41x).`,
    };
  }
  if (result && !resultAccountMatchesType(result, inv.type) && !REDUCING_RESULT_ACCOUNT[inv.type].test(result)) {
    return {
      rule: "cuenta_sentido",
      message: isSale
        ? `La cuenta ${result} es de gasto y esta factura es emitida: usa una cuenta de ingreso (7xx).`
        : `La cuenta ${result} es de ingreso y esta factura es recibida: usa una cuenta de gasto (6xx).`,
    };
  }
  return null;
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
  const currency = currencyProblem(inv);
  if (currency) problems.push(currency);
  const direction = accountDirectionProblem(inv);
  if (direction) problems.push(direction);
  const balance = balanceProblem(inv);
  if (balance) problems.push(balance);
  return problems;
}
