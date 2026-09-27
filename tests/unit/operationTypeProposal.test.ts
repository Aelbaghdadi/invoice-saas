import { describe, it, expect } from "vitest";
import { unclassifiedGoodsType } from "@/lib/operationTypeProposal";

describe("unclassifiedGoodsType", () => {
  it("el tipo del buzón no es intracomunitario: se guarda lo que dijo la IA", () => {
    expect(unclassifiedGoodsType({ goodsType: null, source: null }, "SERVICIOS")).toEqual({ goodsType: "SERVICIOS", source: "IA" });
  });

  it("si la propuesta ya lleva bienes o servicios, manda la propuesta", () => {
    expect(unclassifiedGoodsType({ goodsType: "BIENES", source: "TERCERO" }, "SERVICIOS")).toEqual({ goodsType: "BIENES", source: "TERCERO" });
  });

  it("sin nada de la IA: la propuesta tal cual", () => {
    expect(unclassifiedGoodsType({ goodsType: null, source: null }, null)).toEqual({ goodsType: null, source: null });
  });
});
