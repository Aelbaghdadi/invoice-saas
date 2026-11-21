"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Paperclip, X } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { attachOriginalDocumentAction, removeOriginalDocumentAction } from "@/app/dashboard/archivo/actions";

// Los de ORIGINAL_ATTACHMENT_MIME y ORIGINAL_ATTACHMENT_MAX_BYTES
// (fileValidation.ts), sin traerse al navegador el lector de ZIP.
const ACCEPT = ".doc,.docx,.xls,.xlsx,.odt,.ods,.rtf";
const MAX_BYTES = 20 * 1024 * 1024;

const buttonClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60";

/**
 * «Adjuntar el original en Word, Excel…» (R19) y, si ya hay uno, cambiarlo o
 * quitarlo (anexo C7). El fichero lo valida el servidor por su contenido; aquí
 * solo se avisa antes de subir uno que pasa del tope.
 */
export function AttachOriginalForm({
  invoiceId,
  current,
  split = false,
  disabled = false,
}: {
  invoiceId: string;
  /** El adjunto de ahora (el suyo o el de su documento dividido). */
  current: { filename: string } | null;
  /** Parte de un documento dividido: el original es el de todo el documento. */
  split?: boolean;
  /** Mientras se analiza no se cambia el medio (R11). */
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const { confirm, dialog } = useConfirm();

  const fail = (message: string) => {
    setError(message);
    toastError(message);
  };

  const upload = (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) {
      fail("El original pasa de 20 MB.");
      return;
    }
    const data = new FormData();
    data.set("invoiceId", invoiceId);
    data.set("file", file);
    startTransition(async () => {
      const res = await attachOriginalDocumentAction(data);
      if (input.current) input.current.value = "";
      if ("error" in res) {
        fail(res.error);
        return;
      }
      success(`Original adjunto: ${file.name}`);
      router.refresh();
    });
  };

  const remove = async () => {
    if (!current) return;
    const ok = await confirm({
      title: `¿Quitar «${current.filename}»?`,
      message: "La factura deja de tener un original adjunto. El fichero no se borra: se queda guardado y en el historial.",
      confirmLabel: "Quitar",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    startTransition(async () => {
      const res = await removeOriginalDocumentAction({ invoiceId });
      if ("error" in res) {
        fail(res.error);
        return;
      }
      success("Original adjunto quitado");
      router.refresh();
    });
  };

  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      {dialog}
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload(file);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} disabled={disabled || pending} onClick={() => input.current?.click()}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : <Paperclip className="h-4 w-4 text-slate-400" />}
          {current ? "Cambiar el original adjunto…" : "Adjuntar el original en Word, Excel…"}
        </button>
        {current && (
          <button type="button" className={buttonClass} disabled={pending} onClick={() => void remove()}>
            <X className="h-4 w-4 text-slate-400" />
            Quitar el original adjunto
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-slate-400">
        {disabled
          ? "Se está analizando: cuando termine, podrás adjuntarlo."
          : <>Si la factura se hizo en Word, Excel u OpenDocument (.doc, .docx, .xls, .xlsx, .odt, .ods o .rtf, hasta 20 MB), ese es el original: la app sigue leyendo el PDF.{split ? " Es un documento dividido: vale para todas sus partes." : ""}</>}
      </p>
      {error && <p role="alert" className="mt-1 text-[12px] text-red-600">{error}</p>}
    </div>
  );
}
