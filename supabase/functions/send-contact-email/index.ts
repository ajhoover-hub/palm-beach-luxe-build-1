import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { timingSafeEqual } from "https://deno.land/std@0.190.0/crypto/timing_safe_equal.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const OFFICE_EMAIL = "aj@bmbpalmbeach.com";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_CHARS = 8192;
const MAX_FIELD_CHARS = 256;
const MAX_EMAIL_CHARS = 254;

// Per-isolate limits. The service-role check is the primary gate; these bound
// how much one caller (or a leaked key) can send before an operator notices.
const SOURCE_LIMIT = { max: 1, windowMs: 10 * 60_000 };
const RECIPIENT_LIMIT = { max: 1, windowMs: 60 * 60_000 };
const GLOBAL_LIMIT = { max: 20, windowMs: 60 * 60_000 };
const MAX_TRACKED_KEYS = 10_000;

interface ContactEmailRequest {
  firstName: string;
  lastName?: string;
  email: string;
  phone?: string;
  message?: string;
  style?: string;
  source?: string;
  projectType?: string;
  timeline?: string;
  ownsLot?: string;
  investmentRange?: string;
}

const OPTIONAL_FIELDS = [
  "lastName",
  "phone",
  "message",
  "style",
  "source",
  "projectType",
  "timeline",
  "ownsLot",
  "investmentRange",
] as const;

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const encoder = new TextEncoder();

function isServiceRoleCaller(req: Request, serviceRoleKey: string): boolean {
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return false;
  return timingSafeEqual(encoder.encode(token), encoder.encode(serviceRoleKey));
}

async function readBodyWithin(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseSubmission(raw: unknown): ContactEmailRequest | { error: string; status: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Invalid request body", status: 400 };
  }
  const body = raw as Record<string, unknown>;
  const { firstName, email } = body;
  if (typeof firstName !== "string" || typeof email !== "string") {
    return { error: "Missing required fields", status: 400 };
  }
  if (firstName.length > MAX_FIELD_CHARS || email.length > MAX_EMAIL_CHARS) {
    return { error: "Field too long", status: 413 };
  }
  const submission: ContactEmailRequest = { firstName, email: email.trim() };
  for (const field of OPTIONAL_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      return { error: `Invalid field: ${field}`, status: 400 };
    }
    const limit = field === "message" ? MAX_MESSAGE_CHARS : MAX_FIELD_CHARS;
    if (value.length > limit) {
      return { error: `Field too long: ${field}`, status: 413 };
    }
    submission[field] = value;
  }
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(submission.email)) {
    return { error: "Invalid email", status: 400 };
  }
  return submission;
}

const rateWindows = new Map<string, { count: number; resetAt: number }>();

function pruneRateWindows(now: number) {
  for (const [key, window] of rateWindows) {
    if (window.resetAt <= now) rateWindows.delete(key);
  }
}

// Checks and consumes every limit in one synchronous step so concurrent
// requests cannot all observe the same free slot.
function tryReserve(limits: { key: string; max: number; windowMs: number }[]): boolean {
  const now = Date.now();
  if (rateWindows.size > MAX_TRACKED_KEYS) pruneRateWindows(now);
  if (rateWindows.size > MAX_TRACKED_KEYS) return false;

  for (const { key, max } of limits) {
    const window = rateWindows.get(key);
    if (window && window.resetAt > now && window.count >= max) return false;
  }
  for (const { key, windowMs } of limits) {
    const window = rateWindows.get(key);
    if (window && window.resetAt > now) {
      window.count += 1;
    } else {
      rateWindows.set(key, { count: 1, resetAt: now + windowMs });
    }
  }
  return true;
}

function sourceOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}

const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!serviceRoleKey || !supabaseUrl) {
    console.error("send-contact-email is missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL");
    return jsonResponse(500, { error: "Server configuration error" });
  }

  if (!isServiceRoleCaller(req, serviceRoleKey)) {
    return jsonResponse(401, { error: "Unauthorized" });
  }

  try {
    const rawBody = await readBodyWithin(req, MAX_BODY_BYTES);
    if (rawBody === null) {
      return jsonResponse(413, { error: "Request body too large" });
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return jsonResponse(400, { error: "Invalid JSON in request body" });
    }

    const parsed = parseSubmission(parsedBody);
    if ("error" in parsed) {
      return jsonResponse(parsed.status, { error: parsed.error });
    }

    const {
      firstName,
      lastName = "",
      email,
      phone,
      message = "",
      style,
      source,
      projectType,
      timeline,
      ownsLot,
      investmentRange,
    } = parsed;

    // Validate required fields. Style Book inquiries don't require lastName or message.
    const isStyleBook = source === "style-book";
    if (!firstName || !email || (!isStyleBook && (!lastName || !message))) {
      return jsonResponse(400, { error: "Missing required fields" });
    }

    const normalizedEmail = email.toLowerCase();
    const reserved = tryReserve([
      { key: "global", ...GLOBAL_LIMIT },
      { key: `source:${sourceOf(req)}`, ...SOURCE_LIMIT },
      { key: `recipient:${normalizedEmail}`, ...RECIPIENT_LIMIT },
    ]);
    if (!reserved) {
      return jsonResponse(429, { error: "Too many requests" });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: suppressed, error: suppressionError } = await supabase
      .from("suppressed_emails")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();
    if (suppressionError) {
      console.error("Suppression check failed; the confirmation will not be sent", suppressionError);
    }
    const sendConfirmation = !suppressionError && !suppressed;

    const fullName = `${firstName}${lastName ? " " + lastName : ""}`.trim();
    const investmentDisplay = !isStyleBook
      ? (investmentRange?.trim() ? investmentRange : "Not specified")
      : "";
    console.log("Sending contact form email for:", fullName, email, "source:", source);

    // Send notification email to the team
    const teamEmailResponse = await resend.emails.send({
      from: "Beau Monde Builders <onboarding@resend.dev>",
      to: [OFFICE_EMAIL],
      subject: isStyleBook
        ? `Style Book Inquiry — ${style ?? "Unspecified"} — ${fullName}`
        : `New Contact Form Submission from ${fullName}`,
      html: `
        <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #B8860B; font-weight: 300; font-size: 28px; margin-bottom: 30px;">${isStyleBook ? "Style Book Inquiry" : "New Contact Form Submission"}</h1>

          ${isStyleBook && style ? `
          <div style="background: #f4efe4; padding: 24px 30px; margin-bottom: 20px; border-left: 3px solid #B8860B;">
            <p style="margin: 0; color: #555; font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase;">Style of Interest</p>
            <p style="margin: 8px 0 0; color: #0f2a3d; font-size: 22px;">${style}</p>
          </div>` : ""}

          <div style="background: #f9f9f9; padding: 30px; margin-bottom: 30px;">
            <h2 style="color: #333; font-size: 18px; margin-bottom: 20px;">Contact Details</h2>
            <p style="margin: 10px 0; color: #555;"><strong>Name:</strong> ${fullName}</p>
            <p style="margin: 10px 0; color: #555;"><strong>Email:</strong> <a href="mailto:${email}" style="color: #B8860B;">${email}</a></p>
            ${phone ? `<p style="margin: 10px 0; color: #555;"><strong>Phone:</strong> <a href="tel:${phone}" style="color: #B8860B;">${phone}</a></p>` : ''}
            ${projectType ? `<p style="margin: 10px 0; color: #555;"><strong>Project type:</strong> ${projectType}</p>` : ''}
            ${timeline ? `<p style="margin: 10px 0; color: #555;"><strong>Timeline:</strong> ${timeline}</p>` : ''}
            ${ownsLot ? `<p style="margin: 10px 0; color: #555;"><strong>Owns a lot:</strong> ${ownsLot}</p>` : ''}
            ${investmentDisplay ? `<p style="margin: 10px 0; color: #555;"><strong>Investment range:</strong> ${investmentDisplay}</p>` : ''}
          </div>

          ${message ? `<div style="background: #f9f9f9; padding: 30px;">
            <h2 style="color: #333; font-size: 18px; margin-bottom: 20px;">Message</h2>
            <p style="color: #555; line-height: 1.6; white-space: pre-wrap;">${message}</p>
          </div>` : ""}

          <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
            This email was sent from the Beau Monde Builders ${isStyleBook ? "Style Book" : "contact form"}.
          </p>
        </div>
      `,
    });

    console.log("Team notification email sent:", teamEmailResponse);

    if (!sendConfirmation) {
      console.log("Confirmation skipped: address is suppressed or could not be checked");
      return jsonResponse(200, { success: true, confirmationSent: false });
    }

    // Send confirmation email to the user
    const userEmailResponse = await resend.emails.send({
      from: "Beau Monde Builders <onboarding@resend.dev>",
      to: [email],
      subject: isStyleBook
        ? "Thank You — Your Style Book Inquiry"
        : "Thank You for Contacting Beau Monde Builders",
      html: `
        <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #B8860B; font-weight: 300; font-size: 28px; margin-bottom: 30px;">Thank You, ${firstName}</h1>

          <p style="color: #555; line-height: 1.8; font-size: 16px;">
            ${isStyleBook && style
              ? `We've noted your interest in <strong>${style}</strong> and appreciate you reaching out to Beau Monde Builders.`
              : "We have received your message and appreciate you reaching out to Beau Monde Builders."}
          </p>

          <p style="color: #555; line-height: 1.8; font-size: 16px;">
            Our team will review your inquiry and respond within one business day to schedule your private consultation.
          </p>
          ${!isStyleBook || projectType || timeline || ownsLot ? `
          <div style="background: #f9f9f9; padding: 24px 30px; margin-top: 8px;">
            ${projectType ? `<p style="margin: 8px 0; color: #555;"><strong>Project type:</strong> ${projectType}</p>` : ''}
            ${timeline ? `<p style="margin: 8px 0; color: #555;"><strong>Timeline:</strong> ${timeline}</p>` : ''}
            ${ownsLot ? `<p style="margin: 8px 0; color: #555;"><strong>Owns a lot:</strong> ${ownsLot}</p>` : ''}
            ${investmentDisplay ? `<p style="margin: 8px 0; color: #555;"><strong>Investment range:</strong> ${investmentDisplay}</p>` : ''}
          </div>` : ''}
          
          <div style="margin-top: 40px; padding-top: 30px; border-top: 1px solid #eee;">
            <p style="color: #333; font-weight: 500; margin-bottom: 10px;">Beau Monde Builders Palm Beach</p>
            <p style="color: #777; font-size: 14px; margin: 5px 0;">205 Worth Avenue, Suite 120</p>
            <p style="color: #777; font-size: 14px; margin: 5px 0;">Palm Beach, FL 33480</p>
            <p style="color: #777; font-size: 14px; margin: 5px 0;">(561) 646-8992</p>
          </div>
        </div>
      `,
    });

    console.log("User confirmation email sent:", userEmailResponse);

    return new Response(
      JSON.stringify({ success: true, message: "Emails sent successfully" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  } catch (error: any) {
    console.error("Error in send-contact-email function:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
