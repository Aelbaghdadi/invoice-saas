/** Dígitos máximos de una cuenta contable (grupo + subcuenta, sin contar el punto separador) */
const MAX_DIGITS = 8;

/**
 * Limpia lo que teclea el usuario en un campo de cuenta contable: solo
 * dígitos y como mucho un punto separador, sin superar los 8 dígitos.
 */
export function sanitizeAccountingAccountInput(raw: string): string {
  let digitCount = 0;
  let sawDot = false;
  let result = "";
  for (const char of raw) {
    if (char === "." && !sawDot) {
      sawDot = true;
      result += char;
      continue;
    }
    if (/\d/.test(char) && digitCount < MAX_DIGITS) {
      digitCount++;
      result += char;
    }
  }
  return result;
}

/**
 * Al salir del campo, completa la cuenta hasta los 8 dígitos rellenando con
 * ceros, como hacen los programas de contabilidad. El punto es solo un atajo
 * para teclear y no se conserva en el valor final:
 *
 *   "600"   -> "60000000"   (sin punto, la cuenta crece hacia la derecha)
 *   "4.22"  -> "40000022"   (con punto, la subcuenta queda pegada al final)
 *   "430.1" -> "43000001"
 */
export function padAccountingAccount(value: string): string {
  const dotIndex = value.indexOf(".");
  const group = dotIndex === -1 ? value : value.slice(0, dotIndex);
  const subaccount = dotIndex === -1 ? "" : value.slice(dotIndex + 1);

  // Sin ningun digito no hay nada que completar: campo vacio o un punto suelto.
  if (group.length + subaccount.length === 0) return "";

  const zeros = Math.max(0, MAX_DIGITS - group.length - subaccount.length);
  return `${group}${"0".repeat(zeros)}${subaccount}`;
}

/**
 * AccountEntry ya guarda las cuentas por sentido (supplier/expense en
 * compras, customer/income en ventas), asi que estas dos comprobaciones ya
 * no eligen entre cuentas guardadas: eso lo hace `accountsForDirection`.
 *
 * Lo que hacen ahora es guardar la ESCRITURA. Son la unica red que impide
 * que un 43000053 tecleado por error en una compra se aprenda como cuenta de
 * proveedor, o que un 40000046 tecleado en una venta caiga en la de cliente
 * y vuelva a dejar la ficha mezclada.
 */
export function partyAccountMatchesType(
  account: string | null | undefined,
  invoiceType: "PURCHASE" | "SALE",
): boolean {
  if (!account) return false;
  // Lista NEGRA, no blanca: solo rechazamos la familia del sentido contrario.
  // Una 44x (deudores varios) o cualquier otra cuenta que el asesor use a
  // proposito tiene que seguir funcionando; exigir 43x/40x descartaba cuentas
  // legitimas y ademas impedia que se aprendieran.
  return invoiceType === "SALE" ? !/^4[01]/.test(account) : !/^43/.test(account);
}

/** Cuenta de resultado: en compras no puede ser un ingreso 7xx, y en ventas
 *  no puede ser un gasto 6xx. El resto (inmovilizado 2xx, existencias 3xx…)
 *  se acepta: son contrapartidas legitimas que el gestor elige. */
export function resultAccountMatchesType(
  account: string | null | undefined,
  invoiceType: "PURCHASE" | "SALE",
): boolean {
  if (!account) return false;
  return invoiceType === "SALE" ? !/^6/.test(account) : !/^7/.test(account);
}

/**
 * Normaliza una cuenta del plan de cuentas (Excel de A3 o alta manual).
 * Con punto ("430.00001") se expande a 8 digitos sin punto, igual que la
 * teclea el gestor, para que la columna H del export no mezcle formatos.
 * Sin punto se deja tal cual: rellenar a la derecha cambiaria el numero de
 * una cuenta que ya tiene otro largo.
 */
export function normalizePlanAccount(raw: string): string {
  const value = raw.trim();
  return /^[0-9]+[.][0-9]*$/.test(value) ? padAccountingAccount(value) : value;
}

/** Grupo contable de una cuenta: sus tres primeros digitos. null si no los tiene. */
export function accountGroup(account: string): number | null {
  const digits = account.replace(/[^0-9]/g, "");
  return digits.length >= 3 ? parseInt(digits.slice(0, 3), 10) : null;
}

/** Las cuentas de una ficha de tercero segun el sentido de la factura. */
export type DirectionAccounts = { party: string; result: string };

/**
 * Cuentas que tocan a una factura segun su sentido: en una compra las del
 * proveedor (40x/41x + gasto), en una venta las del cliente (43x + ingreso).
 *
 * Se elige por SENTIDO, no por prefijo: la cuenta de resultado de una compra
 * puede ser legitimamente un inmovilizado 2xx o unas existencias 3xx, y
 * filtrar por "6xx" las dejaria fuera.
 */
export function accountsForDirection(
  entry: {
    supplierAccount?: string | null;
    customerAccount?: string | null;
    expenseAccount?: string | null;
    incomeAccount?: string | null;
  } | null | undefined,
  invoiceType: "PURCHASE" | "SALE",
): DirectionAccounts {
  if (!entry) return { party: "", result: "" };
  return invoiceType === "SALE"
    ? { party: entry.customerAccount ?? "", result: entry.incomeAccount ?? "" }
    : { party: entry.supplierAccount ?? "", result: entry.expenseAccount ?? "" };
}

/**
 * Columnas donde se aprende una cuenta segun el sentido. Devuelve solo las
 * que pasan el guardian de familia: una cuenta de la familia contraria no se
 * aprende (se sigue usando en ESA factura, pero no se guarda en la ficha).
 */
export function learnAccountsForDirection(
  partyAccount: string | null | undefined,
  resultAccount: string | null | undefined,
  invoiceType: "PURCHASE" | "SALE",
): Partial<Record<"supplierAccount" | "customerAccount" | "expenseAccount" | "incomeAccount", string>> {
  const out: Partial<Record<"supplierAccount" | "customerAccount" | "expenseAccount" | "incomeAccount", string>> = {};
  const party = partyAccount?.trim();
  const result = resultAccount?.trim();
  if (party && partyAccountMatchesType(party, invoiceType)) {
    out[invoiceType === "SALE" ? "customerAccount" : "supplierAccount"] = party;
  }
  if (result && resultAccountMatchesType(result, invoiceType)) {
    out[invoiceType === "SALE" ? "incomeAccount" : "expenseAccount"] = result;
  }
  return out;
}
