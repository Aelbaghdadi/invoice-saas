import { Resend } from "resend";
import { BRAND } from "@/lib/brand";
import { MONTH_NAMES, periodLabel, quarterFromMonth, type PeriodTypeName } from "@/lib/period";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Solo cambia el nombre visible: el dominio es el verificado en Resend.
const FROM = process.env.EMAIL_FROM ?? `${BRAND} <noreply@facturocr.com>`;
const APP_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── helpers ────────────────────────────────────────────────────────────────

export type EmailResult = { ok: true } | { ok: false };

/**
 * Para los logs: «a***@dominio.es». El dominio se deja entero (ayuda a ver
 * si falla un proveedor concreto) y del usuario solo la inicial.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** Tope de espera de un envio (Resend no pone ninguno). */
export const EMAIL_TIMEOUT_MS = 10_000;

/**
 * Envia un correo. Resend no lanza: devuelve { data, error }, y antes solo se
 * miraba la excepcion, asi que una clave caducada o un dominio sin verificar
 * se tragaban en silencio (F-039). Registra la plantilla y el destinatario
 * enmascarado y devuelve { ok: false } si falla; quien necesite saberlo
 * (invitacion, restablecer contraseña) mira el resultado.
 */
async function send(template: string, to: string, subject: string, html: string): Promise<EmailResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!resend) {
    // Sin RESEND_API_KEY no se envia nada y cuenta como enviado: cambiarlo
    // haria saltar el aviso de invitacion donde el correo aun no esta
    // montado. El destinatario, enmascarado tambien aqui.
    console.log(`[EMAIL-DEV] ${template} | To: ${maskEmail(to)} | Subject: ${subject}`);
    return { ok: true };
  }

  try {
    // Tope de EMAIL_TIMEOUT_MS: Resend no pone timeout, y la invitacion se
    // espera antes de volver (un servidor que acepta y no responde dejaba al
    // administrador en «Creando...» unos 5 minutos). El signal cancela la
    // peticion (Resend 6.9 lo pasa a fetch aunque su tipo no lo declare); la
    // carrera garantiza el tope aunque una version futura lo ignore.
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), EMAIL_TIMEOUT_MS);
    });
    const request = resend.emails.send(
      { from: FROM, to, subject, html },
      { signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS) } as Parameters<typeof resend.emails.send>[1],
    );
    const result = await Promise.race([request, timeout]);
    if (result === "timeout") {
      console.error(`[EMAIL] No se ha enviado «${template}» a ${maskEmail(to)}: timeout (${EMAIL_TIMEOUT_MS / 1000} s sin respuesta)`);
      return { ok: false };
    }
    const { error } = result;
    if (error) {
      console.error(`[EMAIL] No se ha enviado «${template}» a ${maskEmail(to)}: ${error.name}: ${error.message}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[EMAIL] No se ha enviado «${template}» a ${maskEmail(to)}: ${detail}`);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Resend admite hasta 100 correos por llamada a batch.send. */
export const EMAIL_BATCH_SIZE = 100;

type Message = { to: string; subject: string; html: string };

/**
 * Varios correos de la misma plantilla con el envío en lote de Resend
 * (F-040): una llamada por cada 100, no una por destinatario. Mismo tope de
 * tiempo y mismos registros que send(); devuelve ok: false si falla alguna
 * tanda.
 */
async function sendMany(template: string, messages: Message[]): Promise<EmailResult> {
  if (messages.length === 0) return { ok: true };
  if (!resend) {
    for (const m of messages) console.log(`[EMAIL-DEV] ${template} | To: ${maskEmail(m.to)} | Subject: ${m.subject}`);
    return { ok: true };
  }
  let ok = true;
  for (let i = 0; i < messages.length; i += EMAIL_BATCH_SIZE) {
    const chunk = messages.slice(i, i + EMAIL_BATCH_SIZE);
    const recipients = chunk.map((m) => maskEmail(m.to)).join(", ");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), EMAIL_TIMEOUT_MS);
      });
      const request = resend.batch.send(
        chunk.map((m) => ({ from: FROM, ...m })),
        { signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS) } as Parameters<typeof resend.batch.send>[1],
      );
      const result = await Promise.race([request, timeout]);
      if (result === "timeout") {
        console.error(`[EMAIL] No se ha enviado «${template}» a ${recipients}: timeout (${EMAIL_TIMEOUT_MS / 1000} s sin respuesta)`);
        ok = false;
      } else if (result.error) {
        console.error(`[EMAIL] No se ha enviado «${template}» a ${recipients}: ${result.error.name}: ${result.error.message}`);
        ok = false;
      }
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`[EMAIL] No se ha enviado «${template}» a ${recipients}: ${detail}`);
      ok = false;
    } finally {
      clearTimeout(timer);
    }
  }
  return ok ? { ok: true } : { ok: false };
}

// ─── base template ──────────────────────────────────────────────────────────

function wrap(opts: {
  preheader: string;
  heroIcon: string;
  heroColor: string;
  heroBg: string;
  title: string;
  body: string;
  ctaText?: string;
  ctaUrl?: string;
}): string {
  const cta = opts.ctaText
    ? `<tr><td style="padding:0 40px 32px">
        <table cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="background:${opts.heroColor};border-radius:10px;padding:12px 28px">
            <a href="${opts.ctaUrl}" style="color:#fff;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">${opts.ctaText}</a>
          </td>
        </tr></table>
       </td></tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${opts.title}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <style>
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table,td{mso-table-lspace:0;mso-table-rspace:0}
    img{-ms-interpolation-mode:bicubic;border:0;line-height:100%;outline:none;text-decoration:none}
    a{color:inherit}
    @media only screen and (max-width:620px){
      .outer{width:100%!important;padding:16px!important}
      .inner{padding:24px 20px!important}
      .hero-pad{padding:28px 20px!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;word-spacing:normal;background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif">
  <!-- Preheader text (hidden) -->
  <div style="display:none;font-size:1px;color:#f0f2f5;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">
    ${opts.preheader}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f2f5">
  <tr><td align="center" style="padding:40px 16px" class="outer">

    <!-- Main card -->
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.06)">

      <!-- Logo bar -->
      <tr><td style="padding:20px 40px;border-bottom:1px solid #f0f2f5" class="hero-pad">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="background:#2563eb;border-radius:8px;padding:6px 8px;vertical-align:middle">
                <span style="color:#fff;font-size:12px;font-weight:800;letter-spacing:0.5px">F</span>
              </td>
              <td style="padding-left:10px;vertical-align:middle">
                <span style="font-size:16px;font-weight:700;color:#0f172a;letter-spacing:-0.3px">${BRAND}</span>
              </td>
            </tr></table>
          </td>
        </tr>
        </table>
      </td></tr>

      <!-- Hero icon + title -->
      <tr><td style="padding:36px 40px 20px" class="hero-pad">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="background:${opts.heroBg};border-radius:14px;width:48px;height:48px;text-align:center;vertical-align:middle;font-size:22px">
            ${opts.heroIcon}
          </td>
        </tr></table>
        <h1 style="margin:20px 0 0;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;line-height:1.3">
          ${opts.title}
        </h1>
      </td></tr>

      <!-- Body content -->
      <tr><td style="padding:0 40px 28px" class="inner">
        ${opts.body}
      </td></tr>

      <!-- CTA button -->
      ${cta}

      <!-- Divider -->
      <tr><td style="padding:0 40px"><div style="height:1px;background:#f0f2f5"></div></td></tr>

      <!-- Footer -->
      <tr><td style="padding:24px 40px 28px" class="inner">
        <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;line-height:1.5">
          Este email fue enviado automáticamente por ${BRAND}.
        </p>
        <p style="margin:0;font-size:12px;color:#cbd5e1;line-height:1.5">
          Si no esperabas este mensaje, puedes ignorarlo.
        </p>
      </td></tr>

    </table>

    <!-- Bottom branding -->
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="padding:20px 0;text-align:center">
        <span style="font-size:11px;color:#94a3b8">
          Enviado con ${BRAND} &mdash; Automatiza tu contabilidad
        </span>
      </td></tr>
    </table>

  </td></tr>
  </table>
</body>
</html>`;
}

// ─── detail row helper ──────────────────────────────────────────────────────

function detailRow(label: string, value: string, color = "#0f172a"): string {
  return `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid #f8fafc">
        <p style="margin:0;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px">${label}</p>
        <p style="margin:3px 0 0;font-size:15px;font-weight:600;color:${color};line-height:1.4">${value}</p>
      </td>
    </tr>`;
}

function detailCard(rows: string): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border-radius:12px;overflow:hidden;margin:16px 0 20px">
      ${rows}
    </table>`;
}

// ─── notification templates ─────────────────────────────────────────────────

/** Periodo en mitad de una frase: "enero de 2026" o "el T3 de 2026". El de
 *  periodLabel ("Enero 2026") es para etiquetas; dentro de una frase el mes
 *  va en minuscula ("Recuerda subir tus facturas de enero de 2026"). */
function periodInSentence(periodType: PeriodTypeName, month: number, year: number): string {
  if (periodType === "QUARTERLY") return `el T${quarterFromMonth(month)} de ${year}`;
  const name = MONTH_NAMES[month - 1];
  return name ? `${name.toLowerCase()} de ${year}` : `${month}/${year}`;
}

/**
 * Resumen al cliente cuando se cierra un periodo (F-040): cuántas se han
 * validado, las rechazadas con su motivo y las que quedan pendientes. Antes
 * salía un correo por cada factura validada. El rechazo sigue avisándose al
 * momento (notifyClientInvoiceRejected).
 */
export async function notifyClientPeriodSummary(params: {
  clientEmail: string;
  clientName: string;
  periodType: PeriodTypeName;
  periodMonth: number;
  periodYear: number;
  validated: number;
  rejected: { ref: string; reason: string }[];
  pending: number;
}) {
  const period = periodLabel(params.periodType, params.periodMonth, params.periodYear);
  const periodText = periodInSentence(params.periodType, params.periodMonth, params.periodYear);
  const n = (count: number, singular: string, plural: string) => `${count} ${count === 1 ? singular : plural}`;
  const rejectedList = params.rejected.length > 0
    ? `<p style="margin:0 0 8px;font-size:14px;color:#475569;line-height:1.6">Rechazadas:</p>
       <ul style="margin:0 0 20px;padding-left:20px;font-size:14px;color:#475569;line-height:1.6">
         ${params.rejected.map((r) => `<li><strong style="color:#0f172a">${escapeHtml(r.ref)}</strong>: ${escapeHtml(r.reason)}</li>`).join("")}
       </ul>`
    : "";
  const body = `
    <p style="margin:0 0 4px;font-size:15px;color:#475569;line-height:1.7">
      Hola <strong style="color:#0f172a">${escapeHtml(params.clientName)}</strong>,
    </p>
    <p style="margin:0;font-size:15px;color:#475569;line-height:1.7">
      Hemos cerrado ${periodText}. Este es el resumen de tus facturas:
    </p>
    ${detailCard(
      detailRow("Validadas", String(params.validated), "#16a34a") +
      detailRow("Rechazadas", String(params.rejected.length), params.rejected.length > 0 ? "#dc2626" : "#0f172a") +
      detailRow("Pendientes", String(params.pending), params.pending > 0 ? "#d97706" : "#0f172a")
    )}
    ${rejectedList}
    <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6">
      Puedes consultar todos los detalles desde tu portal de cliente.
    </p>`;

  await send(
    "resumen-periodo",
    params.clientEmail,
    `Resumen de ${period}: ${n(params.validated, "validada", "validadas")}, ${n(params.rejected.length, "rechazada", "rechazadas")}`,
    wrap({
      preheader: `Resumen de tus facturas de ${periodText}.`,
      heroIcon: "&#128203;",
      heroColor: "#2563eb",
      heroBg: "#eff6ff",
      title: `Periodo cerrado: ${period}`,
      body,
      ctaText: "Ver en mi portal",
      ctaUrl: `${APP_URL}/dashboard/client/invoices`,
    }),
  );
}

/**
 * Notify client when their invoice has been rejected
 */
export async function notifyClientInvoiceRejected(params: {
  clientEmail: string;
  clientName: string;
  invoiceNumber: string;
  filename: string;
  reason: string;
}) {
  const invoiceRef = escapeHtml(params.invoiceNumber || params.filename);

  const body = `
    <p style="margin:0 0 4px;font-size:15px;color:#475569;line-height:1.7">
      Hola <strong style="color:#0f172a">${escapeHtml(params.clientName)}</strong>,
    </p>
    <p style="margin:0;font-size:15px;color:#475569;line-height:1.7">
      Tu factura ha sido <strong style="color:#dc2626">rechazada</strong> y requiere tu atención.
    </p>
    ${detailCard(
      detailRow("Factura", invoiceRef) +
      detailRow("Estado", "&#10007; Rechazada", "#dc2626") +
      detailRow("Motivo", escapeHtml(params.reason), "#dc2626")
    )}
    <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6">
      Por favor, revisa el motivo y vuelve a subir el documento corregido desde tu portal.
    </p>`;

  await send(
    "factura-rechazada",
    params.clientEmail,
    `Factura rechazada: ${invoiceRef}`,
    wrap({
      preheader: `Tu factura ${invoiceRef} ha sido rechazada. Motivo: ${escapeHtml(params.reason)}`,
      heroIcon: "&#10060;",
      heroColor: "#dc2626",
      heroBg: "#fef2f2",
      title: "Factura rechazada",
      body,
      ctaText: "Ver en mi portal",
      ctaUrl: `${APP_URL}/dashboard/client/invoices`,
    }),
  );
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(params: {
  to: string;
  resetUrl: string;
}): Promise<EmailResult> {
  const body = `
    <p style="margin:0 0 16px;font-size:15px;color:#475569;line-height:1.7">
      Hemos recibido una solicitud para restablecer la contraseña de tu cuenta en ${BRAND}.
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#475569;line-height:1.7">
      Haz clic en el botón de abajo para crear una nueva contraseña. Este enlace expirará en <strong style="color:#0f172a">1 hora</strong>.
    </p>
    <p style="margin:16px 0 0;font-size:13px;color:#94a3b8;line-height:1.6">
      Si no solicitaste este cambio, puedes ignorar este email. Tu contraseña seguirá siendo la misma.
    </p>`;

  return send(
    "restablecer-contrasena",
    params.to,
    `Restablecer contraseña - ${BRAND}`,
    wrap({
      preheader: `Restablece tu contraseña de ${BRAND}. El enlace expira en 1 hora.`,
      heroIcon: "&#128274;",
      heroColor: "#2563eb",
      heroBg: "#eff6ff",
      title: "Restablecer contraseña",
      body,
      ctaText: "Restablecer contraseña",
      ctaUrl: params.resetUrl,
    }),
  );
}

/**
 * Send invitation email to a newly created client
 */
export async function sendClientInvitationEmail(params: {
  to: string;
  clientName: string;
  inviteUrl: string;
}): Promise<EmailResult> {
  const body = `
    <p style="margin:0 0 4px;font-size:15px;color:#475569;line-height:1.7">
      Hola <strong style="color:#0f172a">${escapeHtml(params.clientName)}</strong>,
    </p>
    <p style="margin:0 0 16px;font-size:15px;color:#475569;line-height:1.7">
      Te damos la bienvenida a <strong style="color:#0f172a">${BRAND}</strong>. Tu cuenta ha sido creada y está lista para usar.
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#475569;line-height:1.7">
      Para acceder a tu portal, primero necesitas establecer tu contraseña haciendo clic en el botón de abajo. Este enlace expirará en <strong style="color:#0f172a">72 horas</strong>.
    </p>
    <p style="margin:16px 0 0;font-size:13px;color:#94a3b8;line-height:1.6">
      Si no esperabas esta invitación, puedes ignorar este email.
    </p>`;

  return send(
    "invitacion-cliente",
    params.to,
    `Bienvenido a ${BRAND} — Establece tu contraseña`,
    wrap({
      preheader: `Tu cuenta en ${BRAND} ha sido creada. Establece tu contraseña para acceder.`,
      heroIcon: "&#128273;",
      heroColor: "#2563eb",
      heroBg: "#eff6ff",
      title: `Bienvenido a ${BRAND}`,
      body,
      ctaText: "Establecer contraseña",
      ctaUrl: params.inviteUrl,
    }),
  );
}

/**
 * Send monthly closure reminder to a client
 */
export async function sendClosureReminder(params: {
  clientEmail: string;
  clientName: string;
  month: number;
  year: number;
}): Promise<EmailResult> {
  const period = periodLabel("MONTHLY", params.month, params.year);
  const periodText = periodInSentence("MONTHLY", params.month, params.year);

  const body = `
    <p style="margin:0 0 4px;font-size:15px;color:#475569;line-height:1.7">
      Hola <strong style="color:#0f172a">${escapeHtml(params.clientName)}</strong>,
    </p>
    <p style="margin:0 0 16px;font-size:15px;color:#475569;line-height:1.7">
      Te recordamos que el periodo de <strong style="color:#0f172a">${periodText}</strong> está pendiente de cierre.
      Por favor, asegúrate de haber subido todas las facturas correspondientes a este periodo antes de que se proceda al cierre.
    </p>
    <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6">
      Si ya has subido todo, puedes ignorar este mensaje. Tu asesoría se encargará del cierre.
    </p>`;

  return send(
    "recordatorio-cierre",
    params.clientEmail,
    `Recordatorio: cierre pendiente de ${periodText}`,
    wrap({
      preheader: `Recuerda subir tus facturas de ${periodText} antes del cierre.`,
      heroIcon: "&#128197;",
      heroColor: "#f59e0b",
      heroBg: "#fffbeb",
      title: `Cierre pendiente: ${period}`,
      body,
      ctaText: "Subir facturas",
      ctaUrl: `${APP_URL}/dashboard/client/upload`,
    }),
  );
}

/**
 * Notify assigned workers when a client uploads new invoices
 */
export async function notifyWorkersNewUpload(params: {
  workerEmails: string[];
  clientName: string;
  count: number;
  periodMonth: number;
  periodYear: number;
  /** Sin él se asume mensual (antes un trimestre salía como su primer mes). */
  periodType?: PeriodTypeName;
}) {
  const periodType = params.periodType ?? "MONTHLY";
  const period = periodLabel(periodType, params.periodMonth, params.periodYear);
  const periodText = periodInSentence(periodType, params.periodMonth, params.periodYear);
  const single = params.count === 1;
  const plural = single ? "" : "s";

  const body = `
    <p style="margin:0;font-size:15px;color:#475569;line-height:1.7">
      Se ${single ? "ha" : "han"} subido <strong style="color:#0f172a">${params.count} factura${plural}</strong> nueva${plural} para revisar.
    </p>
    ${detailCard(
      detailRow("Cliente", escapeHtml(params.clientName)) +
      detailRow("Periodo", period) +
      detailRow("Facturas subidas", String(params.count), "#2563eb")
    )}
    <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6">
      Accede a tu panel para comenzar la revisión.
    </p>`;

  const html = wrap({
    preheader: `${escapeHtml(params.clientName)} ha subido ${params.count} factura${plural} para ${periodText}.`,
    heroIcon: "&#128229;",
    heroColor: "#2563eb",
    heroBg: "#eff6ff",
    title: single ? "Nueva factura pendiente" : "Nuevas facturas pendientes",
    body,
    ctaText: "Revisar facturas",
    ctaUrl: `${APP_URL}/dashboard/worker/invoices`,
  });
  const subject = `${params.clientName} — ${params.count} factura${plural} nueva${plural} (${period})`;
  // Un envío en lote para todos los gestores del cliente (F-040).
  await sendMany("nuevas-facturas-gestor", params.workerEmails.map((to) => ({ to, subject, html })));
}
