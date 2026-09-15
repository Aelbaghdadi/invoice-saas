import { describe, it, expect } from "vitest";
import {
  isIntracomOperation,
  normalizeGoodsType,
  normalizeGoodsSource,
  normalizeGoodsTypeScope,
  goodsTypeFromOperationType,
  purchaseOperationTypeForGoods,
  goodsTypeFromSaleAccount,
  saleAccountForGoodsType,
  proposeIntracomGoodsType,
  initialIntracomGoods,
  goodsTypeQuestion,
  goodsTypeLearning,
} from "@/lib/intracomGoods";

describe("isIntracomOperation", () => {
  it("en compras cuentan el 3 y el 8", () => {
    expect(isIntracomOperation("PURCHASE", "INTRACOM")).toBe(true);
    expect(isIntracomOperation("PURCHASE", "INTRACOM_SERVICIOS")).toBe(true);
    expect(isIntracomOperation("PURCHASE", "INTERIOR")).toBe(false);
  });

  it("en ventas solo la entrega intracomunitaria (3)", () => {
    expect(isIntracomOperation("SALE", "INTRACOM")).toBe(true);
    expect(isIntracomOperation("SALE", "INTRACOM_SERVICIOS")).toBe(false);
    expect(isIntracomOperation("SALE", "IMPORTACION")).toBe(false);
  });
});

describe("normalizeGoodsType / normalizeGoodsSource / normalizeGoodsTypeScope", () => {
  it("acepta las variantes que puede devolver la IA", () => {
    expect(normalizeGoodsType("BIENES")).toBe("BIENES");
    expect(normalizeGoodsType(" servicios ")).toBe("SERVICIOS");
    expect(normalizeGoodsType("Servicio")).toBe("SERVICIOS");
    expect(normalizeGoodsType("goods")).toBe("BIENES");
  });

  it("cualquier otra cosa es null", () => {
    expect(normalizeGoodsType(null)).toBeNull();
    expect(normalizeGoodsType("")).toBeNull();
    expect(normalizeGoodsType("MIXTO")).toBeNull();
    expect(normalizeGoodsType(3)).toBeNull();
  });

  it("origen y respuesta solo admiten sus valores exactos", () => {
    expect(normalizeGoodsSource("IA")).toBe("IA");
    expect(normalizeGoodsSource("MANUAL")).toBe("MANUAL");
    expect(normalizeGoodsSource("ia")).toBeNull();
    expect(normalizeGoodsSource("")).toBeNull();
    expect(normalizeGoodsTypeScope("SIEMPRE")).toBe("SIEMPRE");
    expect(normalizeGoodsTypeScope("SOLO_ESTA")).toBe("SOLO_ESTA");
    expect(normalizeGoodsTypeScope("otra")).toBe("");
    expect(normalizeGoodsTypeScope(null)).toBe("");
  });
});

describe("compras: código 3 / 8", () => {
  it("el código dice bienes o servicios", () => {
    expect(goodsTypeFromOperationType("INTRACOM")).toBe("BIENES");
    expect(goodsTypeFromOperationType("INTRACOM_SERVICIOS")).toBe("SERVICIOS");
    expect(goodsTypeFromOperationType("INTERIOR")).toBeNull();
  });

  it("y al revés", () => {
    expect(purchaseOperationTypeForGoods("BIENES")).toBe("INTRACOM");
    expect(purchaseOperationTypeForGoods("SERVICIOS")).toBe("INTRACOM_SERVICIOS");
  });
});

describe("ventas: cuenta 700 / 705", () => {
  it("la cuenta dice bienes o servicios", () => {
    expect(goodsTypeFromSaleAccount("70000000")).toBe("BIENES");
    expect(goodsTypeFromSaleAccount("70500012")).toBe("SERVICIOS");
    expect(goodsTypeFromSaleAccount("75900000")).toBeNull();
    expect(goodsTypeFromSaleAccount("")).toBeNull();
    expect(goodsTypeFromSaleAccount(null)).toBeNull();
  });

  it("sin cuenta pone la del grupo", () => {
    expect(saleAccountForGoodsType("", "BIENES", false)).toBe("70000000");
    expect(saleAccountForGoodsType("", "SERVICIOS", false)).toBe("70500000");
  });

  it("si ya es del grupo que toca no la cambia", () => {
    expect(saleAccountForGoodsType("70000003", "BIENES", true)).toBe("70000003");
  });

  it("de 700 a 705 cambia el grupo y conserva la subcuenta", () => {
    expect(saleAccountForGoodsType("70000000", "SERVICIOS", false)).toBe("70500000");
    expect(saleAccountForGoodsType("70000012", "SERVICIOS", false)).toBe("70500012");
    expect(saleAccountForGoodsType("70500012", "BIENES", false)).toBe("70000012");
  });

  it("otra cuenta de ingreso solo se sustituye si el gestor pulsa el botón", () => {
    expect(saleAccountForGoodsType("75200000", "SERVICIOS", false)).toBe("75200000");
    expect(saleAccountForGoodsType("75200000", "SERVICIOS", true)).toBe("70500000");
  });

  it("una cuenta tecleada con punto se mira ya completada (70.5 es la 70000005)", () => {
    expect(goodsTypeFromSaleAccount("70.5")).toBe("BIENES");
    expect(goodsTypeFromSaleAccount("7.05")).toBe("BIENES");
    expect(goodsTypeFromSaleAccount("705.1")).toBe("SERVICIOS");
    expect(saleAccountForGoodsType("70.5", "SERVICIOS", false)).toBe("70500005");
    expect(saleAccountForGoodsType("705.1", "SERVICIOS", false)).toBe("70500001");
  });
});

describe("proposeIntracomGoodsType — al procesar la factura", () => {
  it("lo asignado al tercero manda sobre la IA", () => {
    expect(proposeIntracomGoodsType({
      direction: "PURCHASE", operationType: "INTRACOM", thirdParty: "SERVICIOS", ai: "BIENES",
    })).toEqual({ goodsType: "SERVICIOS", source: "TERCERO", operationType: "INTRACOM_SERVICIOS" });
  });

  it("sin tercero asignado usa la IA, y en compras cambia el código", () => {
    expect(proposeIntracomGoodsType({
      direction: "PURCHASE", operationType: "INTRACOM", thirdParty: null, ai: "SERVICIOS",
    })).toEqual({ goodsType: "SERVICIOS", source: "IA", operationType: "INTRACOM_SERVICIOS" });
    expect(proposeIntracomGoodsType({
      direction: "PURCHASE", operationType: "INTRACOM_SERVICIOS", thirdParty: null, ai: "BIENES",
    })).toEqual({ goodsType: "BIENES", source: "IA", operationType: "INTRACOM" });
  });

  it("en compras sin IA ni tercero se queda lo que diga el código", () => {
    expect(proposeIntracomGoodsType({
      direction: "PURCHASE", operationType: "INTRACOM_SERVICIOS", thirdParty: null, ai: null,
    })).toEqual({ goodsType: "SERVICIOS", source: null, operationType: "INTRACOM_SERVICIOS" });
  });

  it("en ventas el código sigue siendo 3", () => {
    expect(proposeIntracomGoodsType({
      direction: "SALE", operationType: "INTRACOM", thirdParty: null, ai: "SERVICIOS",
    })).toEqual({ goodsType: "SERVICIOS", source: "IA", operationType: "INTRACOM" });
    expect(proposeIntracomGoodsType({
      direction: "SALE", operationType: "INTRACOM", thirdParty: null, ai: null,
    })).toEqual({ goodsType: null, source: null, operationType: "INTRACOM" });
  });

  it("fuera de intracomunitarias no propone nada", () => {
    expect(proposeIntracomGoodsType({
      direction: "PURCHASE", operationType: "INTERIOR", thirdParty: "SERVICIOS", ai: "SERVICIOS",
    })).toEqual({ goodsType: null, source: null, operationType: "INTERIOR" });
  });
});

describe("initialIntracomGoods — al abrir la revisión", () => {
  const base = { saved: null, savedSource: null, thirdParty: null, expenseAccount: "", locked: false } as const;

  it("una factura ya validada se abre como se validó, aunque luego se asignara otra cosa al tercero", () => {
    expect(initialIntracomGoods({
      ...base, locked: true, direction: "SALE", operationType: "INTRACOM", saved: "BIENES", savedSource: "IA", thirdParty: "SERVICIOS",
    })).toEqual({ goodsType: "BIENES", source: "IA" });
    expect(initialIntracomGoods({
      ...base, locked: true, direction: "PURCHASE", operationType: "INTRACOM", saved: "BIENES", savedSource: "TERCERO", thirdParty: "SERVICIOS",
    })).toEqual({ goodsType: "BIENES", source: "TERCERO" });
  });

  it("lo marcado a mano en la factura no lo pisa lo asignado al tercero", () => {
    expect(initialIntracomGoods({
      ...base, direction: "SALE", operationType: "INTRACOM", saved: "SERVICIOS", savedSource: "MANUAL", thirdParty: "BIENES",
    })).toEqual({ goodsType: "SERVICIOS", source: "MANUAL" });
    expect(initialIntracomGoods({
      ...base, direction: "PURCHASE", operationType: "INTRACOM", saved: "BIENES", savedSource: "MANUAL", thirdParty: "SERVICIOS",
    })).toEqual({ goodsType: "BIENES", source: "MANUAL" });
  });

  it("lo asignado al tercero gana a lo que dijo la IA", () => {
    expect(initialIntracomGoods({
      ...base, direction: "SALE", operationType: "INTRACOM", saved: "BIENES", savedSource: "IA", thirdParty: "SERVICIOS",
    })).toEqual({ goodsType: "SERVICIOS", source: "TERCERO" });
  });

  it("una venta sin nada se deduce de la cuenta 700/705", () => {
    expect(initialIntracomGoods({
      ...base, direction: "SALE", operationType: "INTRACOM", expenseAccount: "70500000",
    })).toEqual({ goodsType: "SERVICIOS", source: "CUENTA" });
    expect(initialIntracomGoods({
      ...base, direction: "SALE", operationType: "INTRACOM",
    })).toEqual({ goodsType: null, source: null });
  });

  it("en compras manda el código; el origen solo se conserva si coincide", () => {
    expect(initialIntracomGoods({
      ...base, direction: "PURCHASE", operationType: "INTRACOM_SERVICIOS",
    })).toEqual({ goodsType: "SERVICIOS", source: null });
    expect(initialIntracomGoods({
      ...base, direction: "PURCHASE", operationType: "INTRACOM_SERVICIOS", saved: "SERVICIOS", savedSource: "IA",
    })).toEqual({ goodsType: "SERVICIOS", source: "IA" });
    expect(initialIntracomGoods({
      ...base, direction: "PURCHASE", operationType: "INTRACOM", saved: "SERVICIOS", savedSource: "IA",
    })).toEqual({ goodsType: "BIENES", source: null });
  });
});

describe("goodsTypeQuestion — pregunta al validar", () => {
  const base = { direction: "SALE", operationType: "INTRACOM", canRemember: true } as const;

  it("pregunta si el tercero aún no tiene nada asignado", () => {
    expect(goodsTypeQuestion({ ...base, goodsType: "BIENES", thirdParty: null })).toBe("NUEVO");
  });

  it("pregunta si lo marcado es distinto de lo asignado", () => {
    expect(goodsTypeQuestion({ ...base, goodsType: "SERVICIOS", thirdParty: "BIENES" })).toBe("CAMBIO");
  });

  it("no pregunta si coincide, si no se puede guardar o si no aplica", () => {
    expect(goodsTypeQuestion({ ...base, goodsType: "BIENES", thirdParty: "BIENES" })).toBeNull();
    expect(goodsTypeQuestion({ ...base, canRemember: false, goodsType: "BIENES", thirdParty: null })).toBeNull();
    expect(goodsTypeQuestion({ ...base, goodsType: null, thirdParty: null })).toBeNull();
    expect(goodsTypeQuestion({ ...base, operationType: "INTERIOR", goodsType: "BIENES", thirdParty: null })).toBeNull();
  });
});

describe("goodsTypeLearning — qué se guarda en el plan de cuentas", () => {
  const none = { existingPreference: null, seenPreference: null } as const;

  it("«siempre» guarda la clasificación", () => {
    expect(goodsTypeLearning({ ...none, scope: "SIEMPRE", goodsType: "SERVICIOS" }))
      .toEqual({ preference: "SERVICIOS", isException: false });
    expect(goodsTypeLearning({ scope: "SIEMPRE", goodsType: "SERVICIOS", existingPreference: "BIENES", seenPreference: "BIENES" }))
      .toEqual({ preference: "SERVICIOS", isException: false });
  });

  it("«siempre» no pisa lo asignado a un tercero que el gestor no tenía delante", () => {
    // Corrigió el NIF en la revisión a otro proveedor que ya estaba como bienes.
    expect(goodsTypeLearning({ scope: "SIEMPRE", goodsType: "SERVICIOS", existingPreference: "BIENES", seenPreference: null }))
      .toEqual({ preference: null, isException: true });
  });

  it("«solo esta factura» sin nada asignado aprende la factura como cualquier otra", () => {
    expect(goodsTypeLearning({ ...none, scope: "SOLO_ESTA", goodsType: "SERVICIOS" }))
      .toEqual({ preference: null, isException: false });
  });

  it("«solo esta factura» frente a lo asignado es una excepción", () => {
    expect(goodsTypeLearning({ scope: "SOLO_ESTA", goodsType: "SERVICIOS", existingPreference: "BIENES", seenPreference: "BIENES" }))
      .toEqual({ preference: null, isException: true });
  });

  it("sin respuesta: excepción si va contra lo asignado, normal si coincide", () => {
    expect(goodsTypeLearning({ scope: "", goodsType: "SERVICIOS", existingPreference: "BIENES", seenPreference: null }))
      .toEqual({ preference: null, isException: true });
    expect(goodsTypeLearning({ scope: "", goodsType: "BIENES", existingPreference: "BIENES", seenPreference: "BIENES" }))
      .toEqual({ preference: null, isException: false });
  });

  it("sin clasificación no toca nada", () => {
    expect(goodsTypeLearning({ scope: "SIEMPRE", goodsType: null, existingPreference: "BIENES", seenPreference: "BIENES" }))
      .toEqual({ preference: null, isException: false });
  });
});
