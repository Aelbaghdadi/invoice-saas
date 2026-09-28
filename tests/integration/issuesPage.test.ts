// La pagina de incidencias con filtros inventados en la URL: antes llegaban a
// Prisma y daban un 500 (revision 1 del PR #11, punto 16).
import { describe, it, expect } from "vitest";
import { makeFirm } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import IssuesPage from "@/app/dashboard/worker/issues/page";

describe("/dashboard/worker/issues", () => {
  it("status y type inventados: se ignoran, sin error", async () => {
    const w = await makeFirm("A");
    signInAs(w.admin);
    await expect(IssuesPage({ searchParams: Promise.resolve({ status: "<!channel>", type: "@everyone" }) })).resolves.toBeTruthy();
  });
});
