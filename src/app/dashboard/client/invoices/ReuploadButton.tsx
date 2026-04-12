"use client";

import { useRef, useState, useTransition } from "react";
import { Upload } from "lucide-react";
import { reuploadInvoiceAction } from "./reupload-actions";

export function ReuploadButton({ invoiceId }: { invoiceId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const fd = new FormData();
    fd.append("rejectedId", invoiceId);
    fd.append("file", file);
    startTransition(async () => {
      const res = await reuploadInvoiceAction(null, fd);
      if (res?.error) setError(res.error);
      if (inputRef.current) inputRef.current.value = "";
    });
  }

  return (
    <div className="mt-1">
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.xml,.jpg,.jpeg,.png,.webp,.heic"
        onChange={handleFile}
        className="hidden"
      />
      <button
        type="button"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 transition hover:bg-blue-100 disabled:opacity-50"
      >
        <Upload className="h-3 w-3" />
        {pending ? "Subiendo..." : "Re-subir corregida"}
      </button>
      {error && <p className="mt-0.5 text-[11px] text-red-500">{error}</p>}
    </div>
  );
}
