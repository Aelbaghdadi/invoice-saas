import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { requireTestDatabase } from "./guard";
import { startFakeS3 } from "../helpers/fakeS3";

// Antes de importar nada de la app: src/lib/prisma lee DATABASE_URL al
// crearse. Siempre la de pruebas (la guarda ya lo comprobo en globalSetup,
// pero cada fichero corre en su propio contexto).
process.env.DATABASE_URL = requireTestDatabase().url;

// Almacenamiento: un S3 en memoria por fichero, en un puerto libre.
const BUCKET = "facturas-test";
const fakeS3 = await startFakeS3(BUCKET);
globalThis.__facturocrFakeS3 = fakeS3;
process.env.S3_ENDPOINT = fakeS3.endpoint;
process.env.S3_ACCESS_KEY = "test";
process.env.S3_SECRET_KEY = "test";
process.env.S3_BUCKET = BUCKET;
process.env.CRON_SECRET = "cron-test";
// Sin RESEND_API_KEY: el correo no sale y cuenta como enviado.
delete process.env.RESEND_API_KEY;
// Sin GEMINI_API_KEY: los PDF van por el OCR simulado. Con una clave en el
// entorno, processInvoice llamaria a extractPdfWithGemini y a Gemini de verdad.
delete process.env.GEMINI_API_KEY;

// Lo unico que se simula: la sesion, next/cache, next/navigation, after() y
// el OCR. Prisma y Postgres son los reales.
vi.mock("@/lib/auth", async () => {
  const { currentSession } = await import("../helpers/session");
  return { auth: async () => currentSession(), signIn: vi.fn(), signOut: vi.fn(), handlers: {} };
});
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  refresh: () => {},
  updateTag: () => {},
}));
vi.mock("next/navigation", () => ({
  RedirectType: { push: "push", replace: "replace" },
  // Como el real en una server action: push salvo que se pida replace.
  redirect: (url: string, type: "push" | "replace" = "push") => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${type};${url};307;`, url, redirectType: type });
  },
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
}));
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  const { enqueueAfter } = await import("../helpers/after");
  return { ...original, after: enqueueAfter };
});
vi.mock("@/lib/ocr", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ocr")>();
  const { ocrReply } = await import("../helpers/ocr");
  return { ...original, extractInvoiceFromPdf: () => ocrReply(), extractInvoiceFromImage: () => ocrReply() };
});
vi.mock("@/lib/ocrLlm", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ocrLlm")>();
  const { ocrReply } = await import("../helpers/ocr");
  return {
    ...original,
    extractPdfWithGemini: async () => ({ source: "gemini_text" as const, result: await ocrReply() }),
    extractFromPdfTextWithGemini: async () => ({ result: await ocrReply(), complete: true }),
    extractFromDocumentWithGemini: () => ocrReply(),
  };
});

const { resetDatabase, disconnect } = await import("../helpers/db");
const { signOut } = await import("../helpers/session");
const { discardAfterCallbacks } = await import("../helpers/after");
const { resetOcrStub } = await import("../helpers/ocr");
const { settleInFlight } = await import("../helpers/inflight");

// Bloqueos que un test fallido dejo abiertos y acciones a medias: se cierran
// antes del TRUNCATE del siguiente test.
afterEach(async () => {
  // GET que el test dejo retenidos en el S3 simulado ("hold"): fallan, para
  // que las acciones que esperan por ellos terminen.
  fakeS3.setMode("ok");
  fakeS3.releaseGets({ fail: true });
  await settleInFlight();
});

beforeEach(async () => {
  await resetDatabase();
  fakeS3.clear();
  signOut();
  discardAfterCallbacks();
  resetOcrStub();
});

afterAll(async () => {
  await disconnect();
  await fakeS3.close();
});
