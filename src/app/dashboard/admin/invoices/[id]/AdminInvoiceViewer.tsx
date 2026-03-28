"use client";

import { useState, useEffect } from "react";
import { Loader2, FileText, Image as ImageIcon, ExternalLink } from "lucide-react";
import PdfViewer from "@/components/ui/PdfViewerDynamic";

type Props = { invoiceId: string; fileType: string; filename: string };

export function AdminInvoiceViewer({ invoiceId, fileType, filename }: Props) {
  const isImage = fileType.startsWith("image/");
  const isXml   = fileType.includes("xml");

  const [url, setUrl]         = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/invoices/${invoiceId}/preview`)
      .then((r) => r.json())
      .then((d) => { setUrl(d.url); setLoading(false); })
      .catch(() => setLoading(false));
  }, [invoiceId]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-slate-300" />
      </div>
    );
  }

  if (isXml) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
        <FileText className="h-12 w-12" />
        <p className="text-[13px]">Archivo XML — datos extraídos automáticamente</p>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-700"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Abrir archivo
          </a>
        )}
      </div>
    );
  }

  if (!url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
        <ImageIcon className="h-12 w-12" />
        <p className="text-[13px]">Vista previa no disponible</p>
      </div>
    );
  }

  if (isImage) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-[#1e1e2e] p-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={filename}
          className="max-h-full max-w-full rounded-lg shadow-2xl object-contain"
        />
      </div>
    );
  }

  // PDF
  return <PdfViewer url={url} />;
}
