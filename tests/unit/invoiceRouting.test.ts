import { describe, it, expect } from "vitest";
import { routeByCif, clientSideCif, type RoutingCandidate } from "@/lib/invoiceRouting";

// CIFs con dígito de control VÁLIDO (el ruteo exige checksum correcto).
const CANDIDATES: RoutingCandidate[] = [
  { clientId: "rest-a", cif: "B12345674" },
  { clientId: "rest-b", cif: "A58818501" },
  { clientId: "rest-c", cif: "G28029643" },
];

describe("clientSideCif", () => {
  it("en COMPRA el cliente es el receptor", () => {
    expect(clientSideCif("PURCHASE", { issuerCif: "X", receiverCif: "B12345674" })).toBe("B12345674");
  });
  it("en VENTA el cliente es el emisor", () => {
    expect(clientSideCif("SALE", { issuerCif: "B12345674", receiverCif: "X" })).toBe("B12345674");
  });
  it("devuelve null si falta el lado", () => {
    expect(clientSideCif("PURCHASE", { issuerCif: "X", receiverCif: null })).toBeNull();
  });
});

describe("routeByCif", () => {
  it("rutea cuando el CIF casa con un candidato", () => {
    expect(routeByCif(CANDIDATES, "A58818501")).toEqual({ status: "routed", clientId: "rest-b" });
  });

  it("normaliza prefijo de país y separadores", () => {
    expect(routeByCif(CANDIDATES, "ES B-12345674")).toEqual({ status: "routed", clientId: "rest-a" });
    expect(routeByCif(CANDIDATES, "b12345674")).toEqual({ status: "routed", clientId: "rest-a" });
  });

  it("unclassified(no_cif) si no hay CIF", () => {
    expect(routeByCif(CANDIDATES, null)).toEqual({ status: "unclassified", reason: "no_cif" });
    expect(routeByCif(CANDIDATES, "   ")).toEqual({ status: "unclassified", reason: "no_cif" });
  });

  it("unclassified(invalid_cif) si el CIF no pasa el dígito de control", () => {
    expect(routeByCif(CANDIDATES, "B12345670")).toEqual({ status: "unclassified", reason: "invalid_cif" });
  });

  it("unclassified(no_match) si es válido pero no casa con ninguno", () => {
    // DNI válido que no está entre los candidatos.
    expect(routeByCif(CANDIDATES, "12345678Z")).toEqual({ status: "unclassified", reason: "no_match" });
  });

  it("unclassified(ambiguous) si dos candidatos normalizan al mismo CIF", () => {
    const dup: RoutingCandidate[] = [
      { clientId: "x", cif: "ESB12345674" },
      { clientId: "y", cif: "B12345674" },
    ];
    expect(routeByCif(dup, "B12345674")).toEqual({ status: "unclassified", reason: "ambiguous" });
  });

  it("unclassified(ambiguous) si el OTRO lado también es candidato (intra-grupo / tipo invertido)", () => {
    // Cliente = B12345674 (rest-a) pero el emisor también es candidato (A58818501).
    expect(routeByCif(CANDIDATES, "B12345674", "A58818501")).toEqual({ status: "unclassified", reason: "ambiguous" });
  });

  it("rutea normal si el otro lado NO es candidato", () => {
    expect(routeByCif(CANDIDATES, "B12345674", "12345678Z")).toEqual({ status: "routed", clientId: "rest-a" });
  });
});
