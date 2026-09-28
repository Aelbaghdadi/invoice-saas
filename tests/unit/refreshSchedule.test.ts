import { describe, it, expect } from "vitest";
import { nextRefreshDelay, refreshIdleExpired, REFRESH_IDLE_STOP_MS, REFRESH_MAX_MS, REFRESH_MIN_MS } from "@/lib/refreshSchedule";

describe("ritmo del refresco automático (F-081)", () => {
  it("empieza en 5 s y se espacia hasta 60 s", () => {
    const delays: number[] = [];
    let d: number | null = null;
    for (let i = 0; i < 10; i++) delays.push((d = nextRefreshDelay(d)));
    expect(delays[0]).toBe(REFRESH_MIN_MS);
    expect(delays.slice(0, 4)).toEqual([5_000, 7_500, 11_250, 16_875]);
    expect(delays.every((x, i) => i === 0 || x >= delays[i - 1])).toBe(true);
    expect(delays.at(-1)).toBe(REFRESH_MAX_MS);
  });

  it("para a los 10 minutos sin cambios, no antes", () => {
    const t0 = 1_000_000;
    expect(refreshIdleExpired(t0, t0 + REFRESH_IDLE_STOP_MS - 1)).toBe(false);
    expect(refreshIdleExpired(t0, t0 + REFRESH_IDLE_STOP_MS)).toBe(true);
  });

  it("en 10 minutos sin cambios, unas 15 peticiones y no 120", () => {
    let elapsed = 0;
    let d: number | null = null;
    let requests = 0;
    while (true) {
      d = nextRefreshDelay(d);
      if (elapsed + d > REFRESH_IDLE_STOP_MS) break;
      elapsed += d;
      requests++;
    }
    expect(requests).toBeLessThan(20);
  });
});
