import { accountGroup, normalizePlanAccount } from "./accountingAccount";
import { accountEntryKey, sameThirdParty } from "./supplierMatching";

export type PlanImportEntry = {
  nif: string;
  name: string;
  /** Cuentas por sentido: un mismo tercero puede tener ficha de proveedor
   *  (40x/41x + gasto) y de cliente (43x + ingreso) en el mismo Excel. */
  supplierAccount: string;
  customerAccount: string;
  expenseAccount: string;
  incomeAccount: string;
};

/**
 * Agrupa las filas del Excel del plan de cuentas (formato A3: Cuenta |
 * Descripcion | NIF, con la primera fila de cabecera) en una entrada por
 * tercero.
 *
 * Dos filas de cuenta de tercero (4xx) con la misma clave pero con cuentas y
 * nombres distintos son dos terceros que comparten numero. Caso real:
 * CN418306763 "Guangzhou Blings Bag" (40000046) y 418306763 "Guangzhou
 * Hongxin Cosmetics" (41000192), que sin el prefijo de pais dan la misma
 * clave. No se importa ninguna de las dos: juntarlas dejaba a uno con la
 * cuenta o el nombre del otro sin avisar, y cual dependia del orden del Excel.
 */
export function groupPlanRows(rows: unknown[][]): { entries: PlanImportEntry[]; errors: string[] } {
  const entries = new Map<string, PlanImportEntry>();
  const partyRows = new Map<string, { row: number; name: string; account: string; familia: string }[]>();
  const errors: string[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;

    // xlsx entrega las celdas numericas como number: "430.10" llega como 430.1
    // y al expandirlo daria 43000001 en vez de 43000010, la subcuenta de otro
    // tercero. Mejor pedir la columna como texto que adivinar el cero perdido.
    if (typeof row[0] === "number" && !Number.isInteger(row[0])) {
      errors.push(`Fila ${i + 1}: la cuenta ${row[0]} está guardada como número con decimales y puede haber perdido ceros. Formatea la columna de cuentas como texto y vuelve a importar.`);
      continue;
    }
    const cuenta = normalizePlanAccount(String(row[0] ?? ""));
    const descripcion = String(row[1] ?? "").trim();
    const rawNif = String(row[2] ?? "").trim();
    if (!cuenta) continue;

    // Grupo por los tres primeros digitos. Antes se usaba split(".")[0], que
    // con una cuenta sin punto ("40000022", el formato de A3 a 8 digitos)
    // devolvia la cuenta entera y la mandaba siempre a "prefijo desconocido".
    const prefixNum = accountGroup(cuenta) ?? NaN;
    // 400-429 proveedores, 430-439 clientes. El resto del grupo 4 (44x
    // deudores, 46x, 47x) no dice el sentido: sigue contando como cuenta de
    // tercero para la regla de "sin NIF solo entran 4xx", pero se reparte
    // por el fallback de mas abajo.
    const isSupplierAccount = prefixNum >= 400 && prefixNum < 430;
    const isCustomerAccount = prefixNum >= 430 && prefixNum < 440;
    const isPartyAccount = prefixNum >= 400 && prefixNum < 500;

    // Sin NIF solo entra si la cuenta es de tercero (4xx): un proveedor sin
    // VAT fiable, que se identificara por nombre. Una linea sin NIF de gasto,
    // ingreso o banco ("62900000 | Otros servicios") no es un tercero y
    // ensuciaba el plan con filas SINNIF: que ademas se fusionaban entre si
    // por descripcion.
    if (!rawNif && !isPartyAccount) continue;

    // Clave de identidad del tercero: el NIF limpio si tiene contenido, o el
    // nombre normalizado si es basura (proveedores extranjeros, habitual en
    // chinos, sin NIF/VAT). Usar el NIF basura tal cual fusionaria en una
    // sola fila a dos proveedores distintos que comparten el mismo relleno.
    const key = accountEntryKey(rawNif, descripcion);
    if (!key) continue;

    const existing = entries.get(key) ?? {
      nif: key, name: descripcion,
      supplierAccount: "", customerAccount: "", expenseAccount: "", incomeAccount: "",
    };

    if (isSupplierAccount || isCustomerAccount) {
      // Cada familia a su columna: antes las dos caian en supplierAccount y
      // la segunda fila del mismo tercero borraba a la primera, con lo que
      // sobrevivia la que el Excel trajera mas abajo.
      if (isSupplierAccount) existing.supplierAccount = cuenta;
      else existing.customerAccount = cuenta;
      partyRows.set(key, [...(partyRows.get(key) ?? []), { row: i + 1, name: descripcion, account: cuenta, familia: isSupplierAccount ? "proveedor" : "cliente" }]);
    } else if (isPartyAccount) {
      // 44x/46x/47x: es cuenta de tercero, pero no dice de que lado. Se deja
      // en la de proveedor, que es donde estaban hasta ahora.
      existing.supplierAccount = cuenta;
      partyRows.set(key, [...(partyRows.get(key) ?? []), { row: i + 1, name: descripcion, account: cuenta, familia: "proveedor" }]);
    } else if (prefixNum >= 600 && prefixNum < 700) {
      existing.expenseAccount = cuenta;
    } else if (prefixNum >= 700 && prefixNum < 800) {
      existing.incomeAccount = cuenta;
    } else {
      // Unknown prefix — try to assign intelligently
      if (!existing.supplierAccount) {
        existing.supplierAccount = cuenta;
      } else if (!existing.expenseAccount) {
        existing.expenseAccount = cuenta;
      }
    }

    if (!existing.name && descripcion) existing.name = descripcion;
    entries.set(key, existing);
  }

  for (const [key, seen] of partyRows) {
    // El mismo tercero con ficha de cliente y de proveedor (43x y 41x) NO es
    // un conflicto, pero eso ya lo resuelve el nombre: en las dos filas es el
    // mismo, y sameThirdParty lo reconoce. No se compara por familia: dos
    // terceros distintos que comparten numero tienen que saltar aunque uno
    // llegue como cliente y el otro como proveedor.
    const differentThirdParties = seen.some((a, idx) =>
      seen.slice(idx + 1).some((b) => a.account !== b.account && !sameThirdParty(a.name, b.name)),
    );
    if (!differentThirdParties) continue;
    entries.delete(key);
    const detail = seen.map((s) => `fila ${s.row} («${s.name}», cuenta ${s.account} de ${s.familia})`).join(" y ");
    errors.push(`NIF ${key}: ${detail} tienen el mismo número y nombres distintos. No se ha importado ninguna para no mezclar dos terceros: revísalas a mano.`);
  }

  return { entries: [...entries.values()], errors };
}
