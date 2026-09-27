import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyCronSecret } from "@/lib/cronAuth";

describe("verifyCronSecret", () => {
  it("acepta el Bearer con el secreto", () => {
    expect(verifyCronSecret("Bearer s3cr3t", "s3cr3t")).toBe(true);
  });

  it.each([null, "", "Bearer otro!!", "s3cr3t", "bearer s3cr3t", "Bearer s3cr3t "])("rechaza %j", (header) => {
    expect(verifyCronSecret(header, "s3cr3t")).toBe(false);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("una cabecera con los mismos caracteres pero más bytes es 401, no un error", () => {
    expect(() => verifyCronSecret("Bearer éééééé", "s3cr3t")).not.toThrow();
    expect(verifyCronSecret("Bearer éééééé", "s3cr3t")).toBe(false);
    expect(verifyCronSecret("Bearer s3cré", "s3cr3t")).toBe(false);
  });

  it("sin CRON_SECRET configurado no pasa nadie", () => {
    expect(verifyCronSecret("Bearer ", "")).toBe(false);
    vi.stubEnv("CRON_SECRET", "");
    expect(verifyCronSecret("Bearer ")).toBe(false);
  });

  it("por defecto lee CRON_SECRET del entorno", () => {
    vi.stubEnv("CRON_SECRET", "del-entorno");
    expect(verifyCronSecret("Bearer del-entorno")).toBe(true);
  });
});
