/**
 * Tipo de operacion con el que se abre una factura: lo aprendido del tercero
 * en ese cliente (AccountEntry), si vale para el sentido de la factura, y si
 * no el que dice el prefijo del NIF; despues, bienes o servicios en las
 * intracomunitarias. Lo usan el OCR y la clasificacion manual de «Por
 * clasificar»: al clasificar se volvia a comprobar el desglose con el tipo
 * del buzon (INTERIOR), y una inversion del sujeto pasivo aprendida del
 * cliente real salia como desglose descuadrado (revision 2 del PR #7).
 */
import { OPERATION_TYPE_OPTIONS, type IntracomGoodsTypeName, type OperationTypeName } from "@/lib/validators";
import { proposeIntracomGoodsType } from "@/lib/intracomGoods";
import { entryNameMatches } from "@/lib/supplierMatching";

export type LearnedThirdParty = {
  nif: string;
  name: string | null;
  defaultOperationType: OperationTypeName | null;
  intracomGoodsTypePurchase: IntracomGoodsTypeName | null;
  intracomGoodsTypeSale: IntracomGoodsTypeName | null;
};

export function proposeOperationType(input: {
  direction: "PURCHASE" | "SALE";
  /** El que sale del prefijo del NIF de la otra parte (parseTaxId). */
  prefixOperationType: OperationTypeName;
  otherPartyName: string | null | undefined;
  /** Lo aprendido de ese tercero en el cliente, o null. */
  entry: LearnedThirdParty | null;
  /** Bienes o servicios segun la IA, si lo dijo. */
  ai: IntracomGoodsTypeName | null;
}): ReturnType<typeof proposeIntracomGoodsType> {
  const { direction, entry } = input;
  // Lo aprendido se aplica por NIF aunque el nombre no coincida (en el plan
  // de A3 los nombres vienen cortados); lo asignado «siempre» como bienes o
  // servicios si exige el mismo nombre: con dos terceros que comparten
  // numero seria la eleccion del otro.
  const sameThirdParty = entry != null && entryNameMatches(entry, input.otherPartyName);
  // Lo aprendido se guardo en el sentido de aquella factura: un tipo que en
  // este sentido no existe (INTRACOM_SERVICIOS en una emitida) no vale.
  const learned = entry?.defaultOperationType ?? null;
  const base = learned && OPERATION_TYPE_OPTIONS[direction].includes(learned) ? learned : input.prefixOperationType;
  return proposeIntracomGoodsType({
    direction,
    operationType: base,
    thirdParty: sameThirdParty
      ? (direction === "SALE" ? entry!.intracomGoodsTypeSale : entry!.intracomGoodsTypePurchase) ?? null
      : null,
    ai: input.ai,
  });
}
