"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import type { OriginalMedium, OriginalMediumSource } from "@prisma/client";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { canConfirmMedium, MEDIUM_LABELS } from "@/lib/originalMedium";
import { setOriginalMediumAction } from "@/app/dashboard/archivo/actions";

type MediumChoice = OriginalMedium | "UNCONFIRMED";

const CHOICES: MediumChoice[] = ["ELECTRONIC", "PAPER", "UNCONFIRMED"];
const OPTIONS = CHOICES.map((value) => ({ value, label: MEDIUM_LABELS[value] }));

const isChoice = (value: string): value is MediumChoice => (CHOICES as string[]).includes(value);

/**
 * Electrónico, papel o «Por confirmar», a mano. En la ficha lleva el valor de
 * la factura; en una selección de la tabla (`medium` sin pasar) no hay uno
 * solo y pide confirmación antes de cambiar varias. La acción cambia también
 * el resto de cada documento dividido.
 *
 * En la ficha, si el medio lo propuso la app (origen que no es MANUAL), el
 * botón «Confirmar» lo fija a mano con el mismo valor, para que un nuevo
 * análisis ya no lo cambie: el selector no avisa al elegir lo que ya tiene.
 */
export function MediumSelect({
  invoiceIds,
  medium,
  source,
  disabled = false,
  onDone,
  id,
}: {
  invoiceIds: string[];
  /** El medio de la factura (null = «Por confirmar»); sin pasar, una selección de varias. */
  medium?: OriginalMedium | null;
  /** Quién lo decidió (en la ficha); MANUAL ya no se confirma. */
  source?: OriginalMediumSource | null;
  disabled?: boolean;
  onDone?: () => void;
  id?: string;
}) {
  const bulk = medium === undefined;
  const confirmable = !bulk && canConfirmMedium(medium, source ?? null);
  const current: string = bulk ? "" : (medium ?? "UNCONFIRMED");
  const [value, setValue] = useState(current);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const { confirm, dialog } = useConfirm();

  const save = (next: MediumChoice, confirming = false) => {
    const label = MEDIUM_LABELS[next];
    setValue(next);
    startTransition(async () => {
      const res = await setOriginalMediumAction({ invoiceIds, medium: next });
      if ("error" in res) {
        setValue(current);
        toastError(res.error);
        return;
      }
      if (bulk) setValue("");
      success(
        confirming
          ? `Confirmado «${label}»: un nuevo análisis ya no lo cambia`
          : res.changed > 1 ? `${res.changed} facturas marcadas como «${label}»` : `Marcada como «${label}»`,
      );
      router.refresh();
      onDone?.();
    });
  };

  const change = async (next: string) => {
    if (next === value || !isChoice(next)) return;
    if (bulk) {
      const ok = await confirm({
        title: `¿Marcar ${invoiceIds.length === 1 ? "la factura" : `las ${invoiceIds.length} facturas`} como «${MEDIUM_LABELS[next]}»?`,
        message: "Si alguna es parte de un documento dividido, cambia también el resto de sus partes.",
        confirmLabel: "Marcar",
        tone: "primary",
      });
      if (!ok) return;
    }
    save(next);
  };

  return (
    <div className="flex items-center gap-2">
      {dialog}
      <Select
        id={id}
        aria-label="Electrónico o papel"
        size="sm"
        className="w-[190px]"
        value={value}
        placeholder={bulk ? "Electrónico o papel…" : undefined}
        options={OPTIONS}
        onChange={(next) => void change(next)}
        searchable={false}
        disabled={disabled || pending}
      />
      {confirmable && medium && value === current && (
        <button
          type="button"
          onClick={() => save(medium, true)}
          disabled={disabled || pending}
          title="Lo fija a mano: un nuevo análisis ya no lo cambia."
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60"
        >
          Confirmar «{MEDIUM_LABELS[medium]}»
        </button>
      )}
      {pending && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
    </div>
  );
}
