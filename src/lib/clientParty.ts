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
 * Sin imports de servidor: lo usa tambien la pantalla de revision.
 */
import { isValidNIF, parseTaxId } from "@/lib/validators";

export type ReadParty = { name: string | null | undefined; cif: string | null | undefined };

/** La otra parte que leyo el OCR en el lado del cliente, o null si es el cliente. */
export function foreignClientParty(read: ReadParty, client: { cif: string }): { name: string | null; cif: string } | null {
  const cif = parseTaxId(read.cif).clean.toUpperCase();
  if (!cif || !isValidNIF(cif)) return null;
  if (cif === parseTaxId(client.cif).clean.toUpperCase()) return null;
  return { name: read.name?.trim() || null, cif };
}

/** Lo leido en el lado del cliente: receptor en compras, emisor en ventas. */
export function readClientSide(
  type: string,
  read: { issuerName: string | null | undefined; issuerCif: string | null | undefined; receiverName: string | null | undefined; receiverCif: string | null | undefined },
): ReadParty {
  return type === "PURCHASE" ? { name: read.receiverName, cif: read.receiverCif } : { name: read.issuerName, cif: read.issuerCif };
}

/** «Factura a nombre de Ana Pérez (12345678Z), no del cliente.» */
export function foreignClientPartyText(party: { name: string | null; cif: string }): string {
  return `Factura a nombre de ${party.name ? `${party.name} (${party.cif})` : party.cif}, no del cliente.`;
}

/**
 * La incidencia. MANUAL, como el aviso de signo de las rectificativas: los
 * tipos del enum son de otras cosas y uno nuevo necesitaria migracion.
 */
export function foreignClientPartyIssue(read: ReadParty, client: { cif: string }): { type: "MANUAL"; description: string; field: string } | null {
  const party = foreignClientParty(read, client);
  return party ? { type: "MANUAL", description: foreignClientPartyText(party), field: "clientParty" } : null;
}
