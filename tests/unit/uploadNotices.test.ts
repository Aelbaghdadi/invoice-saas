import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { noteUpload, flushUploadNotices, UPLOAD_NOTICE_MAX_WAIT_MS, UPLOAD_NOTICE_QUIET_MS } from "@/lib/uploadNotices";

describe("un aviso por subida, no por fichero (F-040)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => {
    await flushUploadNotices();
    vi.useRealTimers();
  });

  it("5 ficheros seguidos: un aviso con los 5, al dejar de llegar", async () => {
    const sent: number[] = [];
    for (let i = 0; i < 5; i++) {
      noteUpload("c1|MONTHLY|4|2026", async (n) => { sent.push(n); });
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(UPLOAD_NOTICE_QUIET_MS);
    expect(sent).toEqual([5]);
  });

  it("otro cliente o periodo: su propio aviso", async () => {
    const sent: string[] = [];
    noteUpload("c1|MONTHLY|4|2026", async (n) => { sent.push(`c1:${n}`); });
    noteUpload("c2|MONTHLY|4|2026", async (n) => { sent.push(`c2:${n}`); });
    noteUpload("c1|MONTHLY|5|2026", async (n) => { sent.push(`c1-mayo:${n}`); });
    await vi.advanceTimersByTimeAsync(UPLOAD_NOTICE_QUIET_MS);
    expect(sent.sort()).toEqual(["c1-mayo:1", "c1:1", "c2:1"]);
  });

  it("una subida que no para: como mucho a los 5 minutos de la primera", async () => {
    const sent: number[] = [];
    let elapsed = 0;
    while (elapsed < UPLOAD_NOTICE_MAX_WAIT_MS + 10_000) {
      noteUpload("c1|MONTHLY|4|2026", async (n) => { sent.push(n); });
      await vi.advanceTimersByTimeAsync(10_000);
      elapsed += 10_000;
      if (sent.length > 0) break;
    }
    expect(sent).toHaveLength(1);
    expect(elapsed).toBeLessThanOrEqual(UPLOAD_NOTICE_MAX_WAIT_MS + 10_000);
    expect(sent[0]).toBeGreaterThan(25);
  });

  it("un aviso que falla no rompe los siguientes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    noteUpload("c1|MONTHLY|4|2026", async () => { throw new Error("Resend caído"); });
    await vi.advanceTimersByTimeAsync(UPLOAD_NOTICE_QUIET_MS);
    expect(error).toHaveBeenCalledOnce();
    const sent: number[] = [];
    noteUpload("c1|MONTHLY|4|2026", async (n) => { sent.push(n); });
    await vi.advanceTimersByTimeAsync(UPLOAD_NOTICE_QUIET_MS);
    expect(sent).toEqual([1]);
    error.mockRestore();
  });
});
