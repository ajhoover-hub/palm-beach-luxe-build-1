import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_FIELD_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 5000;

// Deliberately narrower than RFC 5322: no characters that carry meaning in a
// mailto: URL (?, &, #, %) or in HTML, and exactly one "@".
const EMAIL_PATTERN =
  /^[A-Za-z0-9._+'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

const SINGLE_LINE_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "style",
  "source",
  "projectType",
  "timeline",
  "ownsLot",
  "investmentRange",
] as const;

type SingleLineField = typeof SINGLE_LINE_FIELDS[number];

type ContactFields = Record<SingleLineField, string> & { message: string };

class InvalidRequestError extends Error {}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const toSingleLine = (value: string): string =>
  value
    .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const toMultiLine = (value: string): string =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/(?![\n\t])[\p{Cc}\u2028\u2029]/gu, " ")
    .trim();

const readField = (body: Record<string, unknown>, name: string): string => {
  const value = body[name];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new InvalidRequestError(`${name} must be a string`);
  }
  return value;
};

const parseContactFields = (body: unknown): ContactFields => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidRequestError("Body must be a JSON object");
  }
  const record = body as Record<string, unknown>;

  const fields = {} as ContactFields;
  for (const name of SINGLE_LINE_FIELDS) {
    const value = toSingleLine(readField(record, name));
    if (value.length > MAX_FIELD_LENGTH) {
      throw new InvalidRequestError(`${name} is too long`);
    }
    fields[name] = value;
  }

  const message = toMultiLine(readField(record, "message"));
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new InvalidRequestError("message is too long");
  }
  fields.message = message;

  if (fields.email && !EMAIL_PATTERN.test(fields.email)) {
    throw new InvalidRequestError("email is invalid");
  }

  return fields;
};

const mailtoHref = (email: string): string =>
  escapeHtml(`mailto:${email.replace(/'/g, "%27")}`);

const telHref = (phone: string): string => {
  const dialable = phone.replace(/[^\d+]/g, "");
  return dialable ? escapeHtml(`tel:${dialable}`) : "";
};

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let fields: ContactFields;
  try {
    fields = parseContactFields(await req.json());
  } catch (error) {
    console.error("Rejected send-contact-email request:", error);
    return jsonResponse({ error: "Invalid request" }, 400);
  }

  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      message,
      style,
      source,
      projectType,
      timeline,
      ownsLot,
      investmentRange,
    } = fields;

    // Validate required fields. Style Book inquiries don't require lastName or message.
    const isStyleBook = source === "style-book";
    if (!firstName || !email || (!isStyleBook && (!lastName || !message))) {
      return jsonResponse({ error: "Missing required fields" }, 400);
    }

    const fullName = `${firstName}${lastName ? " " + lastName : ""}`.trim();
    const investmentDisplay = !isStyleBook
      ? (investmentRange ? investmentRange : "Not specified")
      : "";
    console.log("Sending contact form email for:", fullName, email, "source:", source);

    const safe = {
      firstName: escapeHtml(firstName),
      fullName: escapeHtml(fullName),
      email: escapeHtml(email),
      phone: escapeHtml(phone),
      message: escapeHtml(message),
      style: escapeHtml(style),
      projectType: escapeHtml(projectType),
      timeline: escapeHtml(timeline),
      ownsLot: escapeHtml(ownsLot),
      investmentDisplay: escapeHtml(investmentDisplay),
    };
    const phoneHref = telHref(phone);
    const phoneMarkup = phoneHref
      ? `<a href="${phoneHref}" style="color: #B8860B;">${safe.phone}</a>`
      : safe.phone;

    // Send notification email to the team
    const teamEmailResponse = await resend.emails.send({
      from: "Beau Monde Builders <onboarding@resend.dev>",
      to: ["aj@bmbpalmbeach.com"],
      subject: isStyleBook
        ? `Style Book Inquiry — ${style || "Unspecified"} — ${fullName}`
        : `New Contact Form Submission from ${fullName}`,
      html: `
        <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #B8860B; font-weight: 300; font-size: 28px; margin-bottom: 30px;">${isStyleBook ? "Style Book Inquiry" : "New Contact Form Submission"}</h1>

          ${isStyleBook && style ? `
          <div style="background: #f4efe4; padding: 24px 30px; margin-bottom: 20px; border-left: 3px solid #B8860B;">
            <p style="margin: 0; color: #555; font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase;">Style of Interest</p>
            <p style="margin: 8px 0 0; color: #0f2a3d; font-size: 22px;">${safe.style}</p>
          </div>` : ""}

          <div style="background: #f9f9f9; padding: 30px; margin-bottom: 30px;">
            <h2 style="color: #333; font-size: 18px; margin-bottom: 20px;">Contact Details</h2>
            <p style="margin: 10px 0; color: #555;"><strong>Name:</strong> ${safe.fullName}</p>
            <p style="margin: 10px 0; color: #555;"><strong>Email:</strong> <a href="${mailtoHref(email)}" style="color: #B8860B;">${safe.email}</a></p>
            ${phone ? `<p style="margin: 10px 0; color: #555;"><strong>Phone:</strong> ${phoneMarkup}</p>` : ''}
            ${projectType ? `<p style="margin: 10px 0; color: #555;"><strong>Project type:</strong> ${safe.projectType}</p>` : ''}
            ${timeline ? `<p style="margin: 10px 0; color: #555;"><strong>Timeline:</strong> ${safe.timeline}</p>` : ''}
            ${ownsLot ? `<p style="margin: 10px 0; color: #555;"><strong>Owns a lot:</strong> ${safe.ownsLot}</p>` : ''}
            ${investmentDisplay ? `<p style="margin: 10px 0; color: #555;"><strong>Investment range:</strong> ${safe.investmentDisplay}</p>` : ''}
          </div>

          ${message ? `<div style="background: #f9f9f9; padding: 30px;">
            <h2 style="color: #333; font-size: 18px; margin-bottom: 20px;">Message</h2>
            <p style="color: #555; line-height: 1.6; white-space: pre-wrap;">${safe.message}</p>
          </div>` : ""}

          <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
            This email was sent from the Beau Monde Builders ${isStyleBook ? "Style Book" : "contact form"}.
          </p>
        </div>
      `,
    });

    if (teamEmailResponse.error) {
      throw new Error(`Team notification email failed: ${JSON.stringify(teamEmailResponse.error)}`);
    }
    console.log("Team notification email sent:", teamEmailResponse);

    // Send confirmation email to the user
    const userEmailResponse = await resend.emails.send({
      from: "Beau Monde Builders <onboarding@resend.dev>",
      to: [email],
      subject: isStyleBook
        ? "Thank You — Your Style Book Inquiry"
        : "Thank You for Contacting Beau Monde Builders",
      html: `
        <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #B8860B; font-weight: 300; font-size: 28px; margin-bottom: 30px;">Thank You, ${safe.firstName}</h1>

          <p style="color: #555; line-height: 1.8; font-size: 16px;">
            ${isStyleBook && style
              ? `We've noted your interest in <strong>${safe.style}</strong> and appreciate you reaching out to Beau Monde Builders.`
              : "We have received your message and appreciate you reaching out to Beau Monde Builders."}
          </p>

          <p style="color: #555; line-height: 1.8; font-size: 16px;">
            Our team will review your inquiry and respond within one business day to schedule your private consultation.
          </p>
          ${!isStyleBook || projectType || timeline || ownsLot ? `
          <div style="background: #f9f9f9; padding: 24px 30px; margin-top: 8px;">
            ${projectType ? `<p style="margin: 8px 0; color: #555;"><strong>Project type:</strong> ${safe.projectType}</p>` : ''}
            ${timeline ? `<p style="margin: 8px 0; color: #555;"><strong>Timeline:</strong> ${safe.timeline}</p>` : ''}
            ${ownsLot ? `<p style="margin: 8px 0; color: #555;"><strong>Owns a lot:</strong> ${safe.ownsLot}</p>` : ''}
            ${investmentDisplay ? `<p style="margin: 8px 0; color: #555;"><strong>Investment range:</strong> ${safe.investmentDisplay}</p>` : ''}
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

    if (userEmailResponse.error) {
      throw new Error(`User confirmation email failed: ${JSON.stringify(userEmailResponse.error)}`);
    }
    console.log("User confirmation email sent:", userEmailResponse);

    return jsonResponse({ success: true, message: "Emails sent successfully" }, 200);
  } catch (error) {
    console.error("Error in send-contact-email function:", error);
    return jsonResponse({ error: "Failed to send message" }, 500);
  }
};

serve(handler);
