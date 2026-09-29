import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
// El SDK se carga aqui, en la carga del fichero (sin timeout), y no dentro del
// beforeAll: con la cache fria o bajo carga, importar @aws-sdk podia pasar de
// los 10 s del hook y el fichero entero salia en rojo. vi.resetModules() no
// descarga node_modules, asi que el import de @/lib/storage de abajo lo reutiliza.
import "@aws-sdk/client-s3";

// Un "S3" local que responde segun la clave: 200, 404 o nunca (Garage colgado).
let server: http.Server;
let storage: typeof import("@/lib/storage");

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.includes("existe")) { res.writeHead(200, { "Content-Length": "0" }); res.end(); return; }
    if (req.url?.includes("falta")) { res.writeHead(404); res.end(); return; }
    if (req.url?.includes("prohibido")) { res.writeHead(403); res.end(); return; }
    if (req.url?.includes("contenido")) { res.writeHead(200, { "Content-Length": "5" }); res.end("hola!"); return; }
    // Cabeceras y parte del cuerpo, y luego nada.
    if (req.url?.includes("cuerpo-colgado")) { res.writeHead(200, { "Content-Length": "100" }); res.write("0123456789"); return; }
    // "colgado": no responde nunca.
  });
  // Puerto libre que elige el sistema; si listen falla, falla aqui y con su
  // error, no esperando al timeout del hook.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const { port } = server.address() as AddressInfo;
  vi.stubEnv("S3_ENDPOINT", `http://127.0.0.1:${port}`);
  vi.stubEnv("S3_ACCESS_KEY", "x");
  vi.stubEnv("S3_SECRET_KEY", "y");
  vi.resetModules();
  storage = await import("@/lib/storage");
}, 60_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

// Cortes de 300 ms: lo que se prueba es que cortan, no cuanto tardan. El limite
// deja margen de sobra bajo carga (build de Docker) y el del test aun mas.
const CUT_MS = 300;
const CUT_BOUND_MS = 5_000;
const SLOW_TEST = { timeout: 20_000 };

describe("getObjectBytes", () => {
  it("devuelve el contenido", async () => {
    expect((await storage.getObjectBytes("exports/f/c/contenido.xlsx", { timeoutMs: 10_000 })).toString()).toBe("hola!");
  });

  it.each(["colgado", "cuerpo-colgado"])("con el almacenamiento %s corta a tiempo con un error que no es 'no existe'", SLOW_TEST, async (key) => {
    const t0 = Date.now();
    const err = await storage.getObjectBytes(`exports/f/c/${key}.xlsx`, { timeoutMs: CUT_MS }).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(CUT_BOUND_MS);
    expect(err).toBeInstanceOf(Error);
    // /file lo manda a la rama de console.error + 500 ERR-SYS-001.
    expect(storage.isStorageNotFound(err)).toBe(false);
  });
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

  it("un 403 (credenciales) da false y el aviso dice el código HTTP", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await storage.objectExists("exports/f/c/prohibido.xlsx")).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("(HTTP 403)");
    warn.mockRestore();
  });

  it("con el almacenamiento colgado corta a tiempo, da false y lo deja en el log", SLOW_TEST, async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t0 = Date.now();
    expect(await storage.objectExists("exports/f/c/colgado.xlsx", { timeoutMs: CUT_MS })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(CUT_BOUND_MS);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
