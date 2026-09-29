import { describe, it, expect } from "vitest";
import { Semaphore } from "@/lib/semaphore";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Semaphore (F-029)", () => {
  it("nunca más de N a la vez, y terminan todas", async () => {
    const s = new Semaphore(2);
    let now = 0;
    let max = 0;
    const done: number[] = [];
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.run(async () => {
      now++;
      max = Math.max(max, now);
      await new Promise((r) => setTimeout(r, 5 + (i % 3)));
      now--;
      done.push(i);
    })));
    expect(max).toBe(2);
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([s.active, s.waiting]).toEqual([0, 0]);
  });

  it("una que falla libera el hueco y el error llega a quien la lanzó", async () => {
    const s = new Semaphore(1);
    const failing = s.run(async () => { throw new Error("OCR caído"); });
    const next = s.run(async () => "siguiente");
    await expect(failing).rejects.toThrow("OCR caído");
    await expect(next).resolves.toBe("siguiente");
    expect(s.active).toBe(0);
  });

  it("las que esperan salen en orden de llegada", async () => {
    const s = new Semaphore(1);
    const order: string[] = [];
    let unblock!: () => void;
    const first = s.run(() => new Promise<void>((r) => { unblock = r; }));
    const rest = ["b", "c", "d"].map((k) => s.run(async () => { order.push(k); }));
    await tick();
    expect(s.waiting).toBe(3);
    unblock();
    await Promise.all([first, ...rest]);
    expect(order).toEqual(["b", "c", "d"]);
  });

  it("subir el límite arranca las que esperaban; bajarlo no corta las que corren", async () => {
    const s = new Semaphore(1);
    const releases: (() => void)[] = [];
    const tasks = Array.from({ length: 3 }, () => s.run(() => new Promise<void>((r) => releases.push(r))));
    await tick();
    expect([s.active, s.waiting]).toEqual([1, 2]);
    s.setLimit(3);
    await tick();
    expect([s.active, s.waiting]).toEqual([3, 0]);
    s.setLimit(1);
    const late = s.run(async () => "tarde");
    await tick();
    expect(s.waiting).toBe(1);
    releases.forEach((r) => r());
    await Promise.all(tasks);
    await expect(late).resolves.toBe("tarde");
  });

  it("con prioridad va delante de las que esperan, y entre ellas por orden de llegada; promote hace lo mismo", async () => {
    const s = new Semaphore(1);
    const order: string[] = [];
    let unblock!: () => void;
    const first = s.run(() => new Promise<void>((r) => { unblock = r; }));
    const tasks = [
      s.run(async () => { order.push("a"); }, { key: "a" }),
      s.run(async () => { order.push("b"); }, { key: "b" }),
      s.run(async () => { order.push("c"); }, { key: "c" }),
    ];
    await tick();
    expect([s.position("a"), s.position("c"), s.position("x")]).toEqual([0, 2, null]);
    tasks.push(s.run(async () => { order.push("urgente"); }, { key: "urgente", priority: true }));
    await tick();
    expect(s.promote("c")).toBe(true);
    expect(s.promote("x")).toBe(false);
    tasks.push(s.run(async () => { order.push("urgente2"); }, { key: "urgente2", priority: true }));
    await tick();
    // Cada «Reprocesar» nuevo queda detrás del anterior: su posición no retrocede.
    expect([s.position("urgente"), s.position("c"), s.position("urgente2"), s.position("a")]).toEqual([0, 1, 2, 3]);
    // Promover una que ya es prioritaria no la mueve.
    expect(s.promote("urgente")).toBe(true);
    expect(s.position("urgente")).toBe(0);
    unblock();
    await Promise.all([first, ...tasks]);
    expect(order).toEqual(["urgente", "c", "urgente2", "a", "b"]);
  });

  it("límite no válido: error", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });
});
