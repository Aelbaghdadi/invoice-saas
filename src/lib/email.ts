import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = process.env.EMAIL_FROM ?? "FacturOCR <noreply@facturocr.com>";
const APP_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

// ─── helpers ────────────────────────────────────────────────────────────────

async function send(to: string, subject: string, html: string) {
  if (!resend) {
    console.log(`[EMAIL-DEV] To: ${to} | Subject: ${subject}`);
    return;
  }

  try {
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    console.error("[EMAIL] Error sending:", err);
  }
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
                <span style="font-size:16px;font-weight:700;color:#0f172a;letter-spacing:-0.3px">FacturOCR</span>
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
          Este email fue enviado automáticamente por FacturOCR.
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
          Enviado con FacturOCR &mdash; Automatiza tu contabilidad
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

const MONTHS = [
  "", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/**
 * Notify client when their invoices have been validated
 */
export async function notifyClientInvoiceValidated(params: {
  clientEmail: string;
  clientName: string;
  invoiceNumber: string;
  filename: string;
}) {
  const invoiceRef = params.invoiceNumber || params.filename;

  const body = `
    <p style="margin:0 0 4px;font-size:15px;color:#475569;line-height:1.7">
      Hola <strong style="color:#0f172a">${params.clientName}</strong>,
    </p>
    <p style="margin:0;font-size:15px;color:#475569;line-height:1.7">
      Tu factura ha sido revisada y <strong style="color:#16a34a">validada</strong> por nuestro equipo.
    </p>
    ${detailCard(
      detailRow("Factura", invoiceRef) +
      detailRow("Estado", "&#10003; Validada", "#16a34a")
    )}
    <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6">
      Puedes consultar todos los detalles desde tu portal de cliente.
    </p>`;

  await send(
    params.clientEmail,
    `Factura validada: ${invoiceRef}`,
    wrap({
      preheader: `Tu factura ${invoiceRef} ha sido validada correctamente.`,
      heroIcon: "&#9989;",
      heroColor: "#16a34a",
      heroBg: "#f0fdf4",
      title: "Factura validada",
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
}) {
  const body = `
    <p style="margin:0 0 16px;font-size:15px;color:#475569;line-height:1.7">
      Hemos recibido una solicitud para restablecer la contraseña de tu cuenta en FacturOCR.
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#475569;line-height:1.7">
      Haz clic en el botón de abajo para crear una nueva contraseña. Este enlace expirará en <strong style="color:#0f172a">1 hora</strong>.
    </p>
    <p style="margin:16px 0 0;font-size:13px;color:#94a3b8;line-height:1.6">
      Si no solicitaste este cambio, puedes ignorar este email. Tu contraseña seguirá siendo la misma.
    </p>`;

  await send(
    params.to,
    "Restablecer contraseña - FacturOCR",
    wrap({
      preheader: "Restablece tu contraseña de FacturOCR. El enlace expira en 1 hora.",
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
 * Notify assigned workers when a client uploads new invoices
 */
export async function notifyWorkersNewUpload(params: {
  workerEmails: string[];
  clientName: string;
  count: number;
  periodMonth: number;
  periodYear: number;
}) {
  const period = `${MONTHS[params.periodMonth]} ${params.periodYear}`;

  const body = `
    <p style="margin:0;font-size:15px;color:#475569;line-height:1.7">
      Se han subido <strong style="color:#0f172a">${params.count} factura${params.count > 1 ? "s" : ""}</strong> nuevas para revisar.
    </p>
    ${detailCard(
      detailRow("Cliente", params.clientName) +
      detailRow("Periodo", period) +
      detailRow("Facturas subidas", String(params.count), "#2563eb")
    )}
    <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6">
      Accede a tu panel para comenzar la revisión.
    </p>`;

  for (const email of params.workerEmails) {
    await send(
      email,
      `${params.clientName} — ${params.count} factura${params.count > 1 ? "s" : ""} nuevas (${period})`,
      wrap({
        preheader: `${params.clientName} ha subido ${params.count} facturas para ${period}.`,
        heroIcon: "&#128229;",
        heroColor: "#2563eb",
        heroBg: "#eff6ff",
        title: "Nuevas facturas pendientes",
        body,
        ctaText: "Revisar facturas",
        ctaUrl: `${APP_URL}/dashboard/worker/invoices`,
      }),
    );
  }
}
