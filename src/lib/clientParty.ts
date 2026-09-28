/**
 * Factura a nombre de otro (F-019). En el lado del cliente (receptor en una
 * compra, emisor en una venta) el sistema pone siempre los datos del
 * cliente, y lo que leyo el OCR solo quedaba en la extraccion. Si alli habia
 * un CIF valido de otra parte (el DNI del socio, otra empresa del grupo), la
 * factura se exportaba con IVA deducible como si fuera del cliente.
 *
 * Misma parte, como en clientPartyAudit (PR #11): el mismo CIF. Sin CIF
 * leido, o con uno que no pasa el digito de control, no se avisa: puede ser
 * un error del OCR.
 *
 * Se mira tambien el otro lado:
 * - si alli esta el CIF del cliente, lo que pasa es que emisor y receptor
 *   estan cambiados (o el tipo es el contrario): se avisa de eso, no de que
 *   la factura sea de otro, que empujaria a rechazar una compra legitima;
 * - si los dos lados traen el mismo CIF, el OCR lo ha copiado (un ticket):
 *   no se avisa.
 *
 * Sin imports de servidor: lo usa tambien la pantalla de revision.
 */
import { isValidNIF, parseTaxId } from "@/lib/validators";

export type ReadParties = {
  issuerName: string | null | undefined;
  issuerCif: string | null | undefined;
  receiverName: string | null | undefined;
  receiverCif: string | null | undefined;
};

export type ClientPartyWarning =
  | { kind: "foreign"; name: string | null; cif: string }
  | { kind: "swapped"; clientShownAs: "emisor" | "receptor" };

const cifOf = (raw: string | null | undefined) => parseTaxId(raw).clean.toUpperCase();

/** Lo que hay que avisar del lado del cliente, o null si es el cliente. */
export function clientPartyWarning(type: string, read: ReadParties, client: { cif: string }): ClientPartyWarning | null {
  const purchase = type === "PURCHASE";
  const sideCif = cifOf(purchase ? read.receiverCif : read.issuerCif);
  const sideName = purchase ? read.receiverName : read.issuerName;
  const otherCif = cifOf(purchase ? read.issuerCif : read.receiverCif);
  const clientCif = cifOf(client.cif);
  if (!sideCif || sideCif === clientCif) return null;
  if (sideCif === otherCif) return null;
  if (otherCif && otherCif === clientCif) return { kind: "swapped", clientShownAs: purchase ? "emisor" : "receptor" };
  if (!isValidNIF(sideCif)) return null;
  return { kind: "foreign", name: sideName?.trim() || null, cif: sideCif };
}

/** El texto de la incidencia. */
export function clientPartyWarningText(warning: ClientPartyWarning): string {
  if (warning.kind === "swapped") {
    return `El cliente aparece como ${warning.clientShownAs} en la factura: revisa si emisor y receptor están cambiados o si el tipo es correcto.`;
  }
  return `Factura a nombre de ${warning.name ? `${warning.name} (${warning.cif})` : warning.cif}, no del cliente.`;
}

/**
 * La incidencia. MANUAL, como el aviso de signo de las rectificativas: los
 * tipos del enum son de otras cosas y uno nuevo necesitaria migracion.
 */
export function clientPartyIssue(type: string, read: ReadParties, client: { cif: string }): { type: "MANUAL"; description: string; field: string } | null {
  const warning = clientPartyWarning(type, read, client);
  return warning ? { type: "MANUAL", description: clientPartyWarningText(warning), field: "clientParty" } : null;
}
