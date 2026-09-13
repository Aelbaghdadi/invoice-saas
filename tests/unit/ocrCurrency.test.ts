import { describe, it, expect } from "vitest";
import { detectDocumentAiCurrency } from "@/lib/ocr";

/** Simula el `byType` de mapEntities a partir de un mapa tipo -> entidad. */
const byTypeFrom = (entities: Record<string, object>) => (type: string) => entities[type] as never;

describe("detectDocumentAiCurrency", () => {
  it("usa la entidad currency del documento", () => {
    expect(detectDocumentAiCurrency(byTypeFrom({ currency: { mentionText: "USD" } }))).toBe("USD");
    expect(detectDocumentAiCurrency(byTypeFrom({ currency: { mentionText: "€" } }))).toBe("EUR");
  });

  it("no se cree un currencyCode que el importe no muestra (posible valor por defecto del procesador)", () => {
    const res = detectDocumentAiCurrency(byTypeFrom({
      total_amount: { mentionText: "1.210,50", normalizedValue: { moneyValue: { currencyCode: "USD" } } },
    }));
    expect(res).toBeNull();
  });

  it("sí se lo cree si el importe lleva símbolo o código", () => {
    expect(detectDocumentAiCurrency(byTypeFrom({
      total_amount: { mentionText: "$1,210.50", normalizedValue: { moneyValue: { currencyCode: "USD" } } },
    }))).toBe("USD");
    expect(detectDocumentAiCurrency(byTypeFrom({
      total_amount: { mentionText: "1.210,50 DKK", normalizedValue: { moneyValue: { currencyCode: "DKK" } } },
    }))).toBe("DKK");
  });

  it("no toma cualquier palabra del importe por un código de moneda", () => {
    expect(detectDocumentAiCurrency(byTypeFrom({
      total_amount: { mentionText: "Total 1.210,50", normalizedValue: { moneyValue: { currencyCode: "USD" } } },
    }))).toBeNull();
  });

  it("no acepta un símbolo que no corresponde al código", () => {
    expect(detectDocumentAiCurrency(byTypeFrom({
      total_amount: { mentionText: "100,00 €", normalizedValue: { moneyValue: { currencyCode: "USD" } } },
    }))).toBeNull();
  });

  it("si normalizedValue.text no se reconoce, prueba con el texto de la entidad", () => {
    expect(detectDocumentAiCurrency(byTypeFrom({
      currency: { mentionText: "USD", normalizedValue: { text: "dólares" } },
    }))).toBe("USD");
  });

  it("devuelve null si no hay nada", () => {
    expect(detectDocumentAiCurrency(byTypeFrom({}))).toBeNull();
  });
});
