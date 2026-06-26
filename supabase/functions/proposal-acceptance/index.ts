import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://proposta-digital-vision-chat.vercel.app",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
]);

function corsHeaders(origin: string | null) {
  const safeOrigin = origin && allowedOrigins.has(origin) ? origin : "https://proposta-digital-vision-chat.vercel.app";

  return {
    "Access-Control-Allow-Origin": safeOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

async function notifyCommercial(payload: Record<string, unknown>) {
  const webhookUrl = Deno.env.get("COMMERCIAL_WEBHOOK_URL");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const emailTo = Deno.env.get("COMMERCIAL_EMAIL_TO");
  const emailFrom = Deno.env.get("COMMERCIAL_EMAIL_FROM") ?? "Vision Chat <noreply@visionchat.app.br>";

  if (webhookUrl) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "proposal.accepted",
        source: "proposta-digital-vision-chat",
        payload,
      }),
    });

    if (!response.ok) {
      throw new Error(`Webhook retornou ${response.status}`);
    }

    return "webhook_sent";
  }

  if (resendApiKey && emailTo) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [emailTo],
        subject: "Novo aceite de proposta | Vision Chat Plano Basico",
        text: [
          "Um novo aceite de proposta foi registrado.",
          "",
          `Nome: ${payload.full_name}`,
          `Empresa: ${payload.company}`,
          `Documento: ${payload.document}`,
          `Telefone: ${payload.phone || "-"}`,
          `E-mail: ${payload.email || "-"}`,
          `Plano: ${payload.plan_name}`,
          `Prazo: ${payload.contract_term}`,
          `Pagina: ${payload.page_url || "-"}`,
        ].join("\n"),
      }),
    });

    if (!response.ok) {
      throw new Error(`Resend retornou ${response.status}`);
    }

    return "email_sent";
  }

  return "notification_not_configured";
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Metodo nao permitido" }), {
      status: 405,
      headers,
    });
  }

  try {
    if (origin && !allowedOrigins.has(origin)) {
      return new Response(JSON.stringify({ error: "Origem nao autorizada" }), {
        status: 403,
        headers,
      });
    }

    const body = await req.json();
    if (clean(body.website)) {
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    const acceptance = {
      proposal_slug: "vision-chat-plano-basico-2026",
      plan_name: "Plano Basico",
      contract_term: "6 MESES",
      full_name: clean(body.name),
      company: clean(body.company),
      document: clean(body.document),
      phone: clean(body.phone),
      email: clean(body.email).toLowerCase(),
      page_url: clean(body.page_url),
      user_agent: clean(req.headers.get("user-agent")),
      notification_status: "pending",
    };

    if (!acceptance.full_name || !acceptance.company || !acceptance.document) {
      return new Response(JSON.stringify({ error: "Preencha nome, empresa e CPF/CNPJ." }), {
        status: 400,
        headers,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase
      .from("proposal_acceptances")
      .insert(acceptance)
      .select("id, created_at")
      .single();

    if (error) {
      throw error;
    }

    let notificationStatus = "pending";
    let notificationError = null;

    try {
      notificationStatus = await notifyCommercial({ ...acceptance, id: data.id, created_at: data.created_at });
    } catch (error) {
      notificationStatus = "notification_failed";
      notificationError = error instanceof Error ? error.message : "Falha desconhecida";
    }

    await supabase
      .from("proposal_acceptances")
      .update({
        notification_status: notificationStatus,
        notification_error: notificationError,
      })
      .eq("id", data.id);

    return new Response(JSON.stringify({
      ok: true,
      id: data.id,
      notification_status: notificationStatus,
    }), { headers });
  } catch (error) {
    return new Response(JSON.stringify({
      error: "Nao foi possivel registrar o aceite.",
      details: error instanceof Error ? error.message : "Erro desconhecido",
    }), {
      status: 500,
      headers,
    });
  }
});
