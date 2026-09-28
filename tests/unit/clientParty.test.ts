import { describe, it, expect } from "vitest";
import { foreignClientParty, foreignClientPartyIssue, readClientSide } from "@/lib/clientParty";

const client = { cif: "B12345674" };

describe("factura a nombre de otro (F-019)", () => {
  it("otro CIF válido en el lado del cliente: se avisa con el nombre y el CIF", () => {
    expect(foreignClientPartyIssue({ name: "Ana Pérez", cif: "12345678Z" }, client)).toEqual({
      type: "MANUAL", field: "clientParty", description: "Factura a nombre de Ana Pérez (12345678Z), no del cliente.",
    });
    expect(foreignClientPartyIssue({ name: null, cif: "12345678Z" }, client)?.description).toBe("Factura a nombre de 12345678Z, no del cliente.");
  });

  it("el mismo CIF, aunque venga con prefijo, separadores o el nombre escrito distinto: nada", () => {
    expect(foreignClientParty({ name: "CLIENTE, S.L.", cif: "ESB-12345674" }, client)).toBeNull();
    expect(foreignClientParty({ name: "Otro nombre", cif: "b12345674" }, client)).toBeNull();
  });

  it("sin CIF o con uno que no pasa el dígito de control (error de OCR): nada", () => {
    expect(foreignClientParty({ name: "Otra SL", cif: null }, client)).toBeNull();
    expect(foreignClientParty({ name: "Otra SL", cif: "12345678A" }, client)).toBeNull();
  });

  it("el lado del cliente: receptor en compras, emisor en ventas", () => {
    const read = { issuerName: "E", issuerCif: "1", receiverName: "R", receiverCif: "2" };
    expect(readClientSide("PURCHASE", read)).toEqual({ name: "R", cif: "2" });
    expect(readClientSide("SALE", read)).toEqual({ name: "E", cif: "1" });
  });
});
