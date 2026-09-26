import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Un "S3" local que responde segun la clave: 200, 404 o nunca (Garage colgado).
let server: http.Server;
let storage: typeof import("@/lib/storage");

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.includes("existe")) { res.writeHead(200, { "Content-Length": "0" }); res.end(); return; }
    if (req.url?.includes("falta")) { res.writeHead(404); res.end(); return; }
    // "colgado": no responde nunca.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  vi.stubEnv("S3_ENDPOINT", `http://127.0.0.1:${port}`);
  vi.stubEnv("S3_ACCESS_KEY", "x");
  vi.stubEnv("S3_SECRET_KEY", "y");
  vi.resetModules();
  storage = await import("@/lib/storage");
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  vi.unstubAllEnvs();
});

describe("objectExists", () => {
  it("true si el objeto existe", async () => {
    expect(await storage.objectExists("exports/f/c/existe.xlsx")).toBe(true);
  });

  it("false en silencio si no existe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await storage.objectExists("exports/f/c/falta.xlsx")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("con el almacenamiento colgado corta a tiempo, da false y lo deja en el log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t0 = Date.now();
    expect(await storage.objectExists("exports/f/c/colgado.xlsx", { timeoutMs: 300 })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
