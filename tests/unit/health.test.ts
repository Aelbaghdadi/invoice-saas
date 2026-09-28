import { describe, it, expect, vi } from "vitest";
import { singleFlight, withTimeout } from "@/lib/health";

describe("withTimeout (/api/health)", () => {
  it("si tarda, vale lo del timeout (y se puede avisar ahí)", async () => {
    const onTimeout = vi.fn(() => false);
    expect(await withTimeout(new Promise<boolean>(() => {}), 10, onTimeout)).toBe(false);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("si responde a tiempo, su valor", async () => {
    expect(await withTimeout(Promise.resolve(true), 1000, () => false)).toBe(true);
  });
});

describe("singleFlight", () => {
  it("una sola llamada en curso a la vez", async () => {
    let resolve!: (v: number) => void;
    const fn = vi.fn(() => new Promise<number>((r) => { resolve = r; }));
    const check = singleFlight(fn, 0);
    const a = check();
    const b = check();
    expect(fn).toHaveBeenCalledTimes(1);
    resolve(7);
    expect([await a, await b]).toEqual([7, 7]);
  });

  it("el resultado vale ttl; después se vuelve a comprobar", async () => {
    let t = 0;
    const fn = vi.fn(async () => t);
    const check = singleFlight(fn, 1500, () => t);
    expect(await check()).toBe(0);
    t = 1000;
    expect(await check()).toBe(0);
    t = 1600;
    expect(await check()).toBe(1600);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
