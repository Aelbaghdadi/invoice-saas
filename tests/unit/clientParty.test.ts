import { describe, it, expect } from "vitest";
import { clientPartyIssue, clientPartyWarning } from "@/lib/clientParty";

const client = { cif: "B12345674" };
const PROVIDER = "A58818501";
/** Una compra: lo leído en el receptor es el lado del cliente. */
const purchase = (receiverName: string | null, receiverCif: string | null, issuerCif: string | null = PROVIDER) =>
  ({ issuerName: "Proveedor SL", issuerCif, receiverName, receiverCif });

describe("factura a nombre de otro (F-019)", () => {
  it("otro CIF válido en el lado del cliente: se avisa con el nombre y el CIF", () => {
    expect(clientPartyIssue("PURCHASE", purchase("Ana Pérez", "12345678Z"), client)).toEqual({
      type: "MANUAL", field: "clientParty", description: "Factura a nombre de Ana Pérez (12345678Z), no del cliente.",
    });
    expect(clientPartyIssue("PURCHASE", purchase(null, "12345678Z"), client)?.description).toBe("Factura a nombre de 12345678Z, no del cliente.");
  });

  it("el mismo CIF, aunque venga con prefijo, separadores o el nombre escrito distinto: nada", () => {
    expect(clientPartyWarning("PURCHASE", purchase("CLIENTE, S.L.", "ESB-12345674"), client)).toBeNull();
    expect(clientPartyWarning("PURCHASE", purchase("Otro nombre", "b12345674"), client)).toBeNull();
  });

  it("un VAT extranjero en el lado del cliente también es otra parte, con su país", () => {
    expect(clientPartyWarning("PURCHASE", purchase("Muster GmbH", "DE123456789"), client))
      .toEqual({ kind: "foreign", name: "Muster GmbH", cif: "DE123456789" });
  });

  it("sin CIF o con uno que no pasa el dígito de control (error de OCR): nada", () => {
    expect(clientPartyWarning("PURCHASE", purchase("Otra SL", null), client)).toBeNull();
    expect(clientPartyWarning("PURCHASE", purchase("Otra SL", "12345678A"), client)).toBeNull();
  });

  it("en una venta, el lado del cliente es el emisor", () => {
    const sale = { issuerName: "Ana Pérez", issuerCif: "12345678Z", receiverName: "Comprador", receiverCif: PROVIDER };
    expect(clientPartyWarning("SALE", sale, client)).toEqual({ kind: "foreign", name: "Ana Pérez", cif: "12345678Z" });
  });

  it("partes invertidas (el cliente sale en el otro lado): se avisa de eso, no de que sea de otro", () => {
    // Compra con el cliente como emisor y el proveedor como receptor.
    const swapped = purchase("Proveedor SL", PROVIDER, client.cif);
    expect(clientPartyWarning("PURCHASE", swapped, client)).toEqual({ kind: "swapped", clientShownAs: "emisor" });
    expect(clientPartyIssue("PURCHASE", swapped, client)?.description).toBe(
      "El cliente aparece como emisor en la factura: revisa si emisor y receptor están cambiados o si el tipo es correcto.",
    );
  });

  it("el mismo CIF en los dos lados (el OCR lo ha copiado): nada", () => {
    expect(clientPartyWarning("PURCHASE", purchase("Proveedor SL", PROVIDER, PROVIDER), client)).toBeNull();
  });
});
