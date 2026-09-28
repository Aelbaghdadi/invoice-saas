import { describe, it, expect } from "vitest";
import { formSnapshot } from "@/lib/formSnapshot";
import { altArrowAction } from "@/lib/reviewKeys";

const fd = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

describe("formSnapshot (F-047)", () => {
  it("el orden de los campos no cuenta", () => {
    expect(formSnapshot(fd([["a", "1"], ["b", "2"]]))).toBe(formSnapshot(fd([["b", "2"], ["a", "1"]])));
  });

  it("un valor distinto sí", () => {
    expect(formSnapshot(fd([["totalAmount", "121.00"]]))).not.toBe(formSnapshot(fd([["totalAmount", "121.01"]])));
  });

  it("los campos ignorados no cuentan", () => {
    expect(formSnapshot(fd([["a", "1"], ["nextId", "x"]]), ["nextId"])).toBe(formSnapshot(fd([["a", "1"], ["nextId", "y"]]), ["nextId"]));
  });

  it("un campo que desaparece cuenta", () => {
    expect(formSnapshot(fd([["a", "1"], ["b", ""]]))).not.toBe(formSnapshot(fd([["a", "1"]])));
  });
});

describe("altArrowAction (F-047)", () => {
  const key = (k: string, extra = {}) => ({ key: k, altKey: true, ...extra });

  it("fuera de un campo: cambia de factura", () => {
    expect(altArrowAction(key("ArrowRight"), { inInput: false, isMac: false })).toBe("next");
    expect(altArrowAction(key("ArrowLeft"), { inInput: false, isMac: true })).toBe("prev");
  });

  it("en un campo en Windows/Linux: no navega, pero se intercepta (si no, el navegador va «Atrás»)", () => {
    expect(altArrowAction(key("ArrowLeft"), { inInput: true, isMac: false })).toBe("block");
  });

  it("en un campo en Mac: no se toca (Option+← mueve por palabras)", () => {
    expect(altArrowAction(key("ArrowLeft"), { inInput: true, isMac: true })).toBeNull();
  });

  it("sin Alt, con Ctrl/Cmd u otra tecla: no es el atajo", () => {
    expect(altArrowAction({ key: "ArrowRight", altKey: false }, { inInput: false, isMac: false })).toBeNull();
    expect(altArrowAction(key("ArrowRight", { ctrlKey: true }), { inInput: false, isMac: false })).toBeNull();
    expect(altArrowAction(key("ArrowUp"), { inInput: false, isMac: false })).toBeNull();
  });
});
