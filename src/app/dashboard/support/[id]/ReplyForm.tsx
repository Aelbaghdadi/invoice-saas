"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2, Paperclip, Send } from "lucide-react";
import { addSupportMessage, type MessageFormState } from "../actions";
import { useToast } from "@/components/ui/Toast";
import { SUPPORT_ATTACHMENT_ACCEPT, SUPPORT_BODY_MAX } from "@/lib/support";

export function ReplyForm({ ticketId, staff, resolved }: { ticketId: string; staff: boolean; resolved: boolean }) {
  const action = addSupportMessage.bind(null, ticketId);
  const [state, formAction, pending] = useActionState<MessageFormState, FormData>(action, undefined);
  const [body, setBody] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const { success, warning } = useToast();

  // Al enviar bien: se vacia el formulario y se recarga el hilo.
  useEffect(() => {
    if (!state?.ok) return;
    setBody("");
    setFileName(null);
    formRef.current?.reset();
    if (state.warning) warning(state.warning);
    else success("Respuesta enviada");
    router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <label htmlFor="reply-body" className="block text-[13px] font-semibold text-slate-800">
        {staff ? "Responder como equipo de soporte" : "Responder"}
      </label>
      {resolved && !staff && (
        <p className="text-[12px] text-slate-500">Este ticket está resuelto: si contestas, se vuelve a abrir.</p>
      )}
      {state?.error && (
        <div role="alert" className="flex items-center gap-2.5 rounded-lg border border-red-100 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-700">
          <AlertCircle className="h-4 w-4 flex-shrink-0 text-red-500" />
          {state.error}
        </div>
      )}
      <textarea
        id="reply-body"
        name="body"
        required
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={SUPPORT_BODY_MAX}
        className="input w-full resize-y"
        placeholder={staff ? "Escribe la respuesta: le llegará por correo a quien abrió el ticket." : "Escribe tu respuesta…"}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label
          htmlFor="reply-attachment"
          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] text-slate-600 hover:bg-slate-50"
        >
          <Paperclip className="h-3.5 w-3.5 text-slate-400" />
          {fileName ?? "Adjuntar captura o PDF"}
        </label>
        <input
          id="reply-attachment"
          name="attachment"
          type="file"
          accept={SUPPORT_ATTACHMENT_ACCEPT}
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          className="sr-only"
        />
        <button
          type="submit"
          disabled={pending || body.trim().length === 0}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {pending ? "Enviando..." : "Enviar"}
        </button>
      </div>
    </form>
  );
}
