// /api/health (F-034): Postgres y almacenamiento, sin sesion y sin revelar
// nada interno.
import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/health/route";
import { fakeS3 } from "./helpers/fakeS3";
import { signOut } from "./helpers/session";

describe("/api/health", () => {
  it("todo bien: 200 con { db, storage } y sin sesión", async () => {
    signOut();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ db: true, storage: true });
  });

  it("almacenamiento caído: 503 y solo los dos sí/no, sin hosts ni mensajes", async () => {
    fakeS3().setMode("down");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ db: true, storage: false });
    expect(body).not.toMatch(/127\.0\.0\.1|http|Error/);
  });

  it("almacenamiento colgado: responde a tiempo (timeout corto) con 503", async () => {
    fakeS3().setMode("hang");
    const t0 = Date.now();
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ db: true, storage: false });
    expect(Date.now() - t0).toBeLessThan(4_000);
  });
});
