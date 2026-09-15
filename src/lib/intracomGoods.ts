import { accountGroup, padAccountingAccount } from "./accountingAccount";
import type { IntracomGoodsTypeName, OperationTypeName } from "./validators";

/**
 * Bienes o servicios en operaciones intracomunitarias.
 *
 * - Compras: lo dice el codigo de operacion de A3 (3 = adquisicion de bienes,
 *   8 = de servicios).
 * - Ventas: el codigo es siempre 3 (entrega intracomunitaria) y la diferencia
 *   va en la cuenta de ingreso: 700 bienes, 705 servicios.
 *
 * Lo normal es que un mismo tercero sea siempre bienes o siempre servicios,
 * asi que el gestor puede dejarlo asignado en el plan de cuentas
 * (AccountEntry.intracomGoodsType). Prioridad al proponer: lo marcado a mano
 * en la factura > lo asignado al tercero > la IA > el codigo/cuenta que ya
 * traiga.
 */

type Direction = "PURCHASE" | "SALE";

/** De donde sale la clasificacion de una factura. Prisma `IntracomGoodsSource`. */
export type IntracomGoodsSourceName = "IA" | "TERCERO" | "CUENTA" | "MANUAL";

const GOODS_SOURCES: readonly IntracomGoodsSourceName[] = ["IA", "TERCERO", "CUENTA", "MANUAL"];

/** Respuesta del gestor al validar a "¿este tercero va siempre asi?".
 *  "" = no se le pregunto (ya coincidia, o no se puede guardar). */
export type GoodsTypeScope = "SIEMPRE" | "SOLO_ESTA" | "";

/** Grupo de la cuenta de ingreso en ventas intracomunitarias. */
export const SALE_ACCOUNT_GROUP: Record<IntracomGoodsTypeName, number> = {
  BIENES: 700,
  SERVICIOS: 705,
};

export function isIntracomOperation(
  direction: Direction,
  operationType: string | null | undefined,
): boolean {
  if (direction === "SALE") return operationType === "INTRACOM";
  return operationType === "INTRACOM" || operationType === "INTRACOM_SERVICIOS";
}

/** Lo que devuelve la IA (o llega de un formulario) a BIENES/SERVICIOS. */
export function normalizeGoodsType(raw: unknown): IntracomGoodsTypeName | null {
  if (typeof raw !== "string") return null;
  const value = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase();
  if (value === "BIENES" || value === "BIEN" || value === "GOODS") return "BIENES";
  if (value === "SERVICIOS" || value === "SERVICIO" || value === "SERVICES") return "SERVICIOS";
  return null;
}

export function normalizeGoodsSource(raw: unknown): IntracomGoodsSourceName | null {
  return typeof raw === "string" && (GOODS_SOURCES as readonly string[]).includes(raw)
    ? (raw as IntracomGoodsSourceName)
    : null;
}

export function normalizeGoodsTypeScope(raw: unknown): GoodsTypeScope {
  return raw === "SIEMPRE" || raw === "SOLO_ESTA" ? raw : "";
}

export function goodsTypeFromOperationType(
  operationType: string | null | undefined,
): IntracomGoodsTypeName | null {
  if (operationType === "INTRACOM_SERVICIOS") return "SERVICIOS";
  if (operationType === "INTRACOM") return "BIENES";
  return null;
}

export function purchaseOperationTypeForGoods(goodsType: IntracomGoodsTypeName): OperationTypeName {
  return goodsType === "SERVICIOS" ? "INTRACOM_SERVICIOS" : "INTRACOM";
}

/** Una cuenta tecleada con punto ("70.5") es grupo + subcuenta y se completa
 *  a 70000005: el grupo hay que mirarlo ya completada o "70.5" pareceria 705. */
function completedAccount(account: string): string {
  const value = account.trim();
  return value.includes(".") ? padAccountingAccount(value) : value;
}

export function goodsTypeFromSaleAccount(account: string | null | undefined): IntracomGoodsTypeName | null {
  const group = account ? accountGroup(completedAccount(account)) : null;
  if (group === SALE_ACCOUNT_GROUP.BIENES) return "BIENES";
  if (group === SALE_ACCOUNT_GROUP.SERVICIOS) return "SERVICIOS";
  return null;
}

/**
 * Cuenta de ingreso de una venta intracomunitaria para bienes o servicios.
 *  - Vacia: 70000000 / 70500000.
 *  - Ya del grupo que toca: se deja.
 *  - Del otro (700 <-> 705): se cambia el grupo y se conserva la subcuenta.
 *  - Cualquier otra cuenta: solo se sustituye si `replaceOther` (el gestor
 *    pulso el boton); al abrir la factura se respeta lo que hubiera.
 */
export function saleAccountForGoodsType(
  current: string,
  goodsType: IntracomGoodsTypeName,
  replaceOther: boolean,
): string {
  const target = String(SALE_ACCOUNT_GROUP[goodsType]);
  const value = completedAccount(current);
  if (!value) return padAccountingAccount(target);
  if (accountGroup(value) === SALE_ACCOUNT_GROUP[goodsType]) return value;
  if (/^70[05]/.test(value)) return value.replace(/^70[05]/, target);
  return replaceOther ? padAccountingAccount(target) : value;
}

/**
 * Propuesta al procesar la factura (OCR). `operationType` es el ya decidido
 * por pais o por lo aprendido del tercero. Devuelve el tipo de operacion
 * final: en compras pasa a 3 u 8 segun la clasificacion.
 */
export function proposeIntracomGoodsType(input: {
  direction: Direction;
  operationType: OperationTypeName;
  thirdParty: IntracomGoodsTypeName | null;
  ai: IntracomGoodsTypeName | null;
}): {
  goodsType: IntracomGoodsTypeName | null;
  source: IntracomGoodsSourceName | null;
  operationType: OperationTypeName;
} {
  const { direction, operationType, thirdParty, ai } = input;
  if (!isIntracomOperation(direction, operationType)) {
    return { goodsType: null, source: null, operationType };
  }
  const proposed: { goodsType: IntracomGoodsTypeName | null; source: IntracomGoodsSourceName | null } =
    thirdParty ? { goodsType: thirdParty, source: "TERCERO" }
    : ai ? { goodsType: ai, source: "IA" }
    : { goodsType: direction === "PURCHASE" ? goodsTypeFromOperationType(operationType) : null, source: null };
  return {
    ...proposed,
    operationType: direction === "PURCHASE" && proposed.goodsType
      ? purchaseOperationTypeForGoods(proposed.goodsType)
      : operationType,
  };
}

/**
 * Clasificacion con la que se abre la revision. Lo marcado a mano en la
 * factura manda; si no, lo asignado al tercero (puede haberse asignado despues
 * de procesarla, o venir del buzon "Por clasificar" sin tercero conocido);
 * luego lo guardado; en ventas, la cuenta 700/705; en compras, el codigo 3/8.
 *
 * `locked`: factura ya validada. Se abre tal como se valido; lo asignado al
 * tercero despues no la cambia, porque al guardar se reescribiria el 3/8 o la
 * cuenta de algo ya contabilizado sin que el gestor lo vea.
 */
export function initialIntracomGoods(input: {
  direction: Direction;
  operationType: string;
  saved: IntracomGoodsTypeName | null;
  savedSource: IntracomGoodsSourceName | null;
  thirdParty: IntracomGoodsTypeName | null;
  expenseAccount: string;
  locked: boolean;
}): { goodsType: IntracomGoodsTypeName | null; source: IntracomGoodsSourceName | null } {
  const { direction, operationType, saved, savedSource, thirdParty, expenseAccount, locked } = input;
  if (!isIntracomOperation(direction, operationType)) {
    return { goodsType: saved, source: savedSource };
  }

  if (direction === "PURCHASE") {
    const fromCode = goodsTypeFromOperationType(operationType);
    if (savedSource === "MANUAL") return { goodsType: fromCode, source: "MANUAL" };
    if (thirdParty && !locked) return { goodsType: thirdParty, source: "TERCERO" };
    return { goodsType: fromCode, source: saved === fromCode ? savedSource : null };
  }

  if (saved && (savedSource === "MANUAL" || locked)) return { goodsType: saved, source: savedSource };
  if (thirdParty && !locked) return { goodsType: thirdParty, source: "TERCERO" };
  if (saved) return { goodsType: saved, source: savedSource };
  const fromAccount = goodsTypeFromSaleAccount(expenseAccount);
  if (fromAccount) return { goodsType: fromAccount, source: "CUENTA" };
  return { goodsType: null, source: null };
}

/**
 * ¿Hay que preguntar al validar si este tercero va siempre asi?
 *  - "NUEVO": el tercero aun no tiene nada asignado.
 *  - "CAMBIO": tiene asignado lo contrario de lo marcado en esta factura.
 *  - null: ya coincide, no es intracomunitaria, no hay clasificacion o no se
 *    puede guardar en el plan de cuentas (sin NIF ni nombre, o la fila es de
 *    otro tercero).
 */
export function goodsTypeQuestion(input: {
  direction: Direction;
  operationType: string;
  goodsType: IntracomGoodsTypeName | null;
  thirdParty: IntracomGoodsTypeName | null;
  canRemember: boolean;
}): "NUEVO" | "CAMBIO" | null {
  const { direction, operationType, goodsType, thirdParty, canRemember } = input;
  if (!canRemember || !goodsType || !isIntracomOperation(direction, operationType)) return null;
  if (!thirdParty) return "NUEVO";
  return thirdParty === goodsType ? null : "CAMBIO";
}

/**
 * Que aprender en el plan de cuentas al validar.
 *  - preference: lo que se guarda como "siempre" (null = no tocar).
 *  - isException: esta factura va contra lo asignado al tercero; no hay que
 *    aprender de ella el tipo de operacion ni la cuenta, o la siguiente
 *    factura saldria con los de la excepcion.
 *
 * `seenPreference` es lo asignado que tenia delante el gestor al contestar.
 * Si corrigio el NIF a otro tercero que ya tenia algo distinto asignado,
 * contesto sin verlo: no se pisa.
 */
export function goodsTypeLearning(input: {
  scope: GoodsTypeScope;
  goodsType: IntracomGoodsTypeName | null;
  existingPreference: IntracomGoodsTypeName | null;
  seenPreference: IntracomGoodsTypeName | null;
}): { preference: IntracomGoodsTypeName | null; isException: boolean } {
  const { scope, goodsType, existingPreference, seenPreference } = input;
  if (!goodsType) return { preference: null, isException: false };
  const againstAssigned = existingPreference != null && existingPreference !== goodsType;
  if (scope === "SIEMPRE") {
    if (againstAssigned && seenPreference !== existingPreference) {
      return { preference: null, isException: true };
    }
    return { preference: goodsType, isException: false };
  }
  // "Solo esta factura" (o sin respuesta) nunca toca lo asignado. Sin nada
  // asignado la factura se aprende como cualquier otra: solo es excepcion
  // si va contra lo asignado.
  return { preference: null, isException: againstAssigned };
}
