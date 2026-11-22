"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Layers, Loader2 } from "lucide-react";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { tacoLabel } from "@/lib/paperLocation";
import { convertToTacoAction } from "@/app/dashboard/archivo/tacoActions";

const CONFIRM_TEXT =
  "La tanda pasa a ser un taco con número propio y sus facturas «Por confirmar» pasan a «Papel». Las electrónicas se quedan como están. Las páginas siguen el orden de los nombres de los ficheros: comprueba la hoja antes de guardar el papel. No se puede deshacer.";

/**
 * «Era papel: crear taco» (B-R15) de una tanda digital: al final de la subida
 * (compact), en su detalle y en Tacos → «Subidas digitales».
 */
export function ConvertToTacoButton({
  batchId,
  compact = false,
  label,
  onDone,
}: {
  batchId: string;
  compact?: boolean;
  /** Por defecto «Era papel: crear taco» (o «Crear taco con esta subida» en compact). */
  label?: string;
  onDone?: (result: { tacoNumber: number; converted: number }) => void;
}) {
  const [pending, startTransition] = useTransition();
  const { confirm, dialog } = useConfirm();
  const { success, error: toastError } = useToast();
  const router = useRouter();

  const run = async () => {
    const ok = await confirm({ title: "¿Era papel escaneado aquí?", message: CONFIRM_TEXT, confirmLabel: "Crear el taco" });
    if (!ok) return;
    startTransition(async () => {
      const res = await convertToTacoAction({ batchId });
      if ("error" in res) {
        toastError(res.error);
        return;
      }
      const converted = res.converted;
      success(converted === 0
        ? `Ahora es el ${tacoLabel(res.tacoNumber)}.`
        : `Ahora es el ${tacoLabel(res.tacoNumber)}: ${converted} factura${converted === 1 ? " pasa" : "s pasan"} a papel.`);
      router.refresh();
      onDone?.({ tacoNumber: res.tacoNumber, converted });
    });
  };

  const text = label ?? (compact ? "Crear taco con esta subida" : "Era papel: crear taco");
  return (
    <>
      {dialog}
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className={compact
          ? "inline-flex items-center gap-1 text-[12px] font-semibold text-blue-700 hover:underline disabled:opacity-50"
          : "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"}
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}
        {text}
      </button>
    </>
  );
}
