import Anthropic from "@anthropic-ai/sdk";
import type { MailMessage } from "@prisma/client";
import { db } from "../db";
import { charge, creditsForUsage } from "../credits";
import { consultAs } from "../kb";
import { meteredFetch } from "../ai-meter";

/**
 * AI help inside Mail: a short summary, a reply draft in the sender's
 * language and tone, and a business label (enquiry, purchase order,
 * invoice…) so mail can be sorted and later handed to Tally. Uses the small,
 * fast model and charges the workspace's credits like any other AI use.
 */
const workspaceHeader = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic({ ...(workspaceHeader ? { defaultHeaders: { "anthropic-workspace-id": workspaceHeader } } : {}), fetch: meteredFetch("Mail AI") });
const MODEL = "claude-haiku-5-5";

export const LABELS = ["enquiry", "quotation", "purchase order", "invoice", "payment", "delivery", "complaint", "internal", "newsletter", "other"] as const;

export const bodyOf = (m: MailMessage) => (m.text ?? (m.html ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 12_000);

async function ask(workspaceId: string, userId: string, prompt: string, maxTokens = 2000) {
  const res = await client.messages.create({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] });
  await charge(workspaceId, creditsForUsage(res.usage.input_tokens, res.usage.output_tokens), "GENERATION", undefined, { category: "chat", userId }).catch(() => undefined);
  return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
}

function header(m: MailMessage) {
  return `From: ${m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr}\nDate: ${m.date.toISOString()}\nSubject: ${m.subject}\n\n${bodyOf(m)}`;
}

/** Knowledge first: the company's articles that match this email, as the person reading it. */
async function companyFor(workspaceId: string, userId: string, m: MailMessage, instruction?: string) {
  const c = await consultAs(userId, workspaceId, `${instruction ? `${instruction.slice(0, 200)} ` : ""}${bodyOf(m).slice(0, 300)}`, { context: m.subject, cite: false });
  return c.context ? `\n\n${c.context}` : "";
}

export async function summarize(workspaceId: string, userId: string, m: MailMessage) {
  const text = await ask(
    workspaceId,
    userId,
    `Summarize this email for a busy person in 2–4 short bullet points: what they want, any numbers, dates or amounts, and what action is needed (by the company's own process where the company knowledge below covers it). Use "- " bullets and nothing else.\n\n<email>\n${header(m)}\n</email>${await companyFor(workspaceId, userId, m)}`,
  );
  await db.mailMessage.update({ where: { id: m.id }, data: { aiSummary: text.slice(0, 2000) } });
  return text;
}

export async function draftReply(workspaceId: string, userId: string, m: MailMessage, senderName: string | null, instruction?: string) {
  return ask(
    workspaceId,
    userId,
    `Write a reply to this email on behalf of ${senderName ?? "the recipient"}. Match the sender's language and level of formality, keep it concise and business-appropriate, and don't invent facts, prices or commitments: use the company knowledge below where it covers them, and where a detail is still needed, leave a clear placeholder like [delivery date].${instruction ? ` The person asked: ${instruction.slice(0, 500)}` : ""} Output only the reply body, with no subject line and no source numbers.\n\n<email>\n${header(m)}\n</email>${await companyFor(workspaceId, userId, m, instruction)}`,
  );
}

export async function classify(workspaceId: string, userId: string, m: MailMessage) {
  const out = await ask(
    workspaceId,
    userId,
    `Classify this business email into exactly one of: ${LABELS.join(", ")}. Answer with the label only.\n\n<email>\n${header(m)}\n</email>`,
    1500,
  );
  const label = LABELS.find((l) => out.toLowerCase().includes(l)) ?? "other";
  await db.mailMessage.update({ where: { id: m.id }, data: { aiLabel: label } });
  return label;
}

