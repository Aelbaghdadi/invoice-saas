import { describe, it, expect } from "vitest";
import { splitStorageKey } from "@/lib/splitStorageKey";

const invoice = { clientId: "client1", periodYear: 2026, periodMonth: 9 };

describe("splitStorageKey", () => {
  it("cliente, periodo, instante, identificador único y nombre", () => {
    expect(splitStorageKey(invoice, "a.pdf", 1000, "u-1")).toBe("client1/2026-09/1000-u-1-split-a.pdf");
  });

  it("dos divisiones en el mismo milisegundo no comparten clave", () => {
    const now = Date.now();
    expect(splitStorageKey(invoice, "a.pdf", now)).not.toBe(splitStorageKey(invoice, "a.pdf", now));
  });
});
