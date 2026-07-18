import type { Env } from "../env";

// Expéditeur par défaut : le domaine partagé de Resend, utilisable sans
// vérifier de domaine (mais limité à l'email du compte Resend en destinataire).
// Passer à une adresse d'un domaine vérifié via la var MAIL_FROM.
const DEFAULT_FROM = "Loreforge <onboarding@resend.dev>";

export async function sendMagicLinkEmail(
  env: Env,
  to: string,
  link: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!env.RESEND_API_KEY) return { ok: false, error: "email_not_configured" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.MAIL_FROM ?? DEFAULT_FROM,
      to: [to],
      subject: "Votre lien de connexion Loreforge",
      html: `
        <p>Bonjour,</p>
        <p>Cliquez sur ce lien pour vous connecter à Loreforge :</p>
        <p><a href="${link}">Se connecter</a></p>
        <p>Ce lien est valable 15 minutes et à usage unique.
        Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
      `,
      text: `Connectez-vous à Loreforge : ${link}\nLien valable 15 minutes, à usage unique.`,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[email] Resend ${res.status}: ${detail}`);
    return { ok: false, error: "email_send_failed" };
  }
  return { ok: true };
}
