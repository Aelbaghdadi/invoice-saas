// Ajustes del papel de la asesoría (B-R1): solo el ADMIN de esa asesoría
// cambia «Cómo escaneáis el papel» y «Cómo guardáis las cajas», con zod en el
// límite, sin tocar la otra asesoría ni los tacos hechos.
import { describe, it, expect, beforeEach } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { prisma } from "./helpers/db";
import { makeTwoFirms, makeTaco, type FirmWorld } from "./helpers/factories";
import { signInAs, type TestSessionUser } from "./helpers/session";
import { updatePaperSettings } from "@/app/dashboard/admin/settings/actions";
import SettingsPage from "@/app/dashboard/admin/settings/page";
import { SettingsForm } from "@/app/dashboard/admin/settings/SettingsForm";
import WorkerUploadPage from "@/app/dashboard/worker/upload/page";
import { WorkerUploadForm } from "@/app/dashboard/worker/upload/WorkerUploadForm";

let a: FirmWorld;
let b: FirmWorld;

beforeEach(async () => {
  ({ a, b } = await makeTwoFirms());
});

function save(user: TestSessionUser, values: Record<string, string>) {
  signInAs(user);
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) fd.set(key, value);
  return updatePaperSettings(null, fd);
}

const settingsOf = (w: FirmWorld) =>
  prisma.advisoryFirm.findUniqueOrThrow({ where: { id: w.firm.id }, select: { paperScanMode: true, paperBoxMode: true } });

/** Los elementos de ese componente en el árbol que devuelve una página. */
function find<P>(node: ReactNode, type: unknown, out: ReactElement<P>[] = []): ReactElement<P>[] {
  if (Array.isArray(node)) node.forEach((n) => find(n, type, out));
  else if (isValidElement(node)) {
    if (node.type === type) out.push(node as ReactElement<P>);
    find((node.props as { children?: ReactNode }).children, type, out);
  }
  return out;
}

/** Las props que la página de Ajustes pasa al formulario. */
async function pageProps(user: TestSessionUser) {
  signInAs(user);
  const [form] = find<{ paper: { paperScanMode: string; paperBoxMode: string } }>(await SettingsPage(), SettingsForm);
  return form.props;
}

/** Lo que la página de subida pasa al formulario: lo que sale marcado al subir papel. */
async function uploadPaperProps(user: TestSessionUser) {
  signInAs(user);
  const [form] = find<{ firmPaperScanMode: string; firmPaperBoxMode: string }>(await WorkerUploadPage(), WorkerUploadForm);
  return { paperScanMode: form.props.firmPaperScanMode, paperBoxMode: form.props.firmPaperBoxMode };
}

describe("updatePaperSettings", () => {
  it("por defecto, factura a factura y una caja por cliente y año", async () => {
    expect(await settingsOf(a)).toEqual({ paperScanMode: "PER_INVOICE", paperBoxMode: "PER_CLIENT_YEAR" });
    expect((await pageProps(a.admin)).paper).toEqual({ paperScanMode: "PER_INVOICE", paperBoxMode: "PER_CLIENT_YEAR" });
  });

  it("el ADMIN guarda los dos y la página los lee; la otra asesoría y los tacos hechos no cambian", async () => {
    const taco = await makeTaco(a, { filed: { boxLabel: "Cliente A SL · 2026 · Caja 1" } });
    expect(await save(a.admin, { paperScanMode: "WHOLE_PDF", paperBoxMode: "SHARED" })).toEqual({ success: true });
    expect(await settingsOf(a)).toEqual({ paperScanMode: "WHOLE_PDF", paperBoxMode: "SHARED" });
    expect((await pageProps(a.admin)).paper).toEqual({ paperScanMode: "WHOLE_PDF", paperBoxMode: "SHARED" });
    expect(await settingsOf(b)).toEqual({ paperScanMode: "PER_INVOICE", paperBoxMode: "PER_CLIENT_YEAR" });
    // Al subir sale marcado el ajuste de su asesoría, para el administrador y para el gestor.
    for (const user of [a.admin, a.worker]) {
      expect(await uploadPaperProps(user)).toEqual({ paperScanMode: "WHOLE_PDF", paperBoxMode: "SHARED" });
    }
    for (const user of [b.admin, b.worker]) {
      expect(await uploadPaperProps(user)).toEqual({ paperScanMode: "PER_INVOICE", paperBoxMode: "PER_CLIENT_YEAR" });
    }
    expect(await prisma.uploadBatch.findUniqueOrThrow({ where: { id: taco.id } }))
      .toMatchObject({ wholePdf: false, boxLabel: "Cliente A SL · 2026 · Caja 1" });

    expect(await save(a.admin, { paperScanMode: "PER_INVOICE", paperBoxMode: "PER_CLIENT_YEAR" })).toEqual({ success: true });
    expect(await settingsOf(a)).toEqual({ paperScanMode: "PER_INVOICE", paperBoxMode: "PER_CLIENT_YEAR" });
  });

  it("valores inventados o que faltan: { error } en castellano y nada cambia", async () => {
    expect(await save(a.admin, { paperScanMode: "AL_PESO", paperBoxMode: "SHARED" })).toEqual({ error: "Elige cómo escaneáis el papel." });
    expect(await save(a.admin, { paperScanMode: "WHOLE_PDF", paperBoxMode: "EN_EL_SUELO" })).toEqual({ error: "Elige cómo guardáis las cajas." });
    expect(await save(a.admin, { paperScanMode: "WHOLE_PDF" })).toEqual({ error: "Elige cómo guardáis las cajas." });
    expect(await settingsOf(a)).toEqual({ paperScanMode: "PER_INVOICE", paperBoxMode: "PER_CLIENT_YEAR" });
  });

  it("el gestor y el portal no pueden", async () => {
    for (const user of [a.worker, a.clientUser]) {
      expect(await save(user, { paperScanMode: "WHOLE_PDF", paperBoxMode: "SHARED" })).toEqual({ error: "No autorizado" });
    }
    expect(await settingsOf(a)).toEqual({ paperScanMode: "PER_INVOICE", paperBoxMode: "PER_CLIENT_YEAR" });
  });

  it("el ADMIN de B solo cambia B", async () => {
    expect(await save(b.admin, { paperScanMode: "WHOLE_PDF", paperBoxMode: "SHARED" })).toEqual({ success: true });
    expect(await settingsOf(b)).toEqual({ paperScanMode: "WHOLE_PDF", paperBoxMode: "SHARED" });
    expect(await settingsOf(a)).toEqual({ paperScanMode: "PER_INVOICE", paperBoxMode: "PER_CLIENT_YEAR" });
  });
});
