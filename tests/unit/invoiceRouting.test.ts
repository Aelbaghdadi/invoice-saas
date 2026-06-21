import { describe, it, expect } from "vitest";
import {
  routeByCif,
  clientSideCif,
  routeByText,
  detectInvoiceType,
  type RoutingCandidate,
  type TextRoutingCandidate,
} from "@/lib/invoiceRouting";

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

describe("routeByText", () => {
  const CANDS: TextRoutingCandidate[] = [
    { clientId: "rest-a", cif: "B12345674", name: "Restaurante La Plaza" },
    { clientId: "rest-b", cif: "A58818501", name: "Bar Central" },
    { clientId: "rest-c", cif: "G28029643", name: "Cafetería Sol" },
  ];

  it("rutea por CIF presente en el texto (con separadores)", () => {
    const txt = "FACTURA\nNIF cliente: B-12345674\nTotal 100€";
    expect(routeByText(txt, CANDS)).toEqual({ clientId: "rest-a", via: "cif" });
  });

  it("el CIF tiene prioridad sobre el nombre", () => {
    const txt = "Cliente B12345674 — emitida por Bar Central";
    expect(routeByText(txt, CANDS)).toEqual({ clientId: "rest-a", via: "cif" });
  });

  it("rutea por nombre cuando no hay CIF de ningún candidato", () => {
    const txt = "FACTURA\nCliente: Restaurante La Plaza\nBase 80 IVA 21";
    expect(routeByText(txt, CANDS)).toEqual({ clientId: "rest-a", via: "name" });
  });

  it("el nombre casa sin tildes ni puntuación", () => {
    const txt = "Factura para CAFETERIA SOL S.L.";
    expect(routeByText(txt, CANDS)).toEqual({ clientId: "rest-c", via: "name" });
  });

  it("null si aparecen los CIF de dos candidatos (intragrupo / ambiguo)", () => {
    const txt = "De B12345674 a A58818501 por servicios";
    expect(routeByText(txt, CANDS)).toBeNull();
  });

  it("null si aparecen los nombres de dos candidatos", () => {
    const txt = "Restaurante La Plaza y Bar Central, mismo grupo";
    expect(routeByText(txt, CANDS)).toBeNull();
  });

  it("null si no casa nada", () => {
    expect(routeByText("Ferretería Pepe, NIF 12345678Z", CANDS)).toBeNull();
  });

  it("null si el texto está vacío o no hay candidatos", () => {
    expect(routeByText(null, CANDS)).toBeNull();
    expect(routeByText("", CANDS)).toBeNull();
    expect(routeByText("B12345674", [])).toBeNull();
  });
});

describe("detectInvoiceType", () => {
  it("compra si el cliente es el receptor", () => {
    expect(detectInvoiceType("B12345674", { issuerCif: "A58818501", receiverCif: "B12345674" })).toBe("PURCHASE");
  });
  it("venta si el cliente es el emisor", () => {
    expect(detectInvoiceType("B12345674", { issuerCif: "B-12345674", receiverCif: "A58818501" })).toBe("SALE");
  });
  it("null si el CIF del cliente no aparece en ningún lado", () => {
    expect(detectInvoiceType("G28029643", { issuerCif: "A58818501", receiverCif: "B12345674" })).toBeNull();
  });
  it("null si falta el CIF del cliente", () => {
    expect(detectInvoiceType(null, { issuerCif: "A58818501", receiverCif: "B12345674" })).toBeNull();
  });
  it("null si el mismo CIF aparece en ambos lados (ambiguo)", () => {
    expect(detectInvoiceType("B12345674", { issuerCif: "B12345674", receiverCif: "B12345674" })).toBeNull();
  });
});
