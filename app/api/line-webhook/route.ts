import { validateSignature, webhook } from "@line/bot-sdk";
import { DEFAULT_REPLY } from "@/lib/constants";
import { askGemini } from "@/lib/gemini";
import { notifyStaff, type HandoffReason } from "@/lib/handoff";
import { lineClient } from "@/lib/line";
import { buildContext } from "@/lib/context";
import { getBotData } from "@/lib/data";
import { getHistory, pushHistory } from "@/lib/history";
import { buildPrompt } from "@/lib/prompt";

type WebhookEvent = webhook.Event;

export const runtime = "nodejs";
export const maxDuration = 30;

const recent = new Map<string, number>();
const MIN = 60_000;

function shouldNotify(key: string, windowMs: number): boolean {
  const now = Date.now();
  for (const [k, t] of Array.from(recent)) if (now - t > 30 * MIN) recent.delete(k);
  const last = recent.get(key);
  if (last && now - last < windowMs) return false;
  recent.set(key, now);
  return true;
}

async function reply(replyToken: string, userId: string, text: string) {
  try {
    await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text }] });
  } catch (e) {
    console.error("reply failed", userId, String(e));
  }
}

async function handoff(
  userId: string,
  question: string,
  reason: HandoffReason,
  branch?: string,
  product?: string,
) {
  const key =
    reason === "cut_branch" ? `${userId}|cut|${branch}|${product}` : `${userId}|${reason}`;
  if (!shouldNotify(key, reason === "cut_branch" ? 10 * MIN : 30 * MIN)) return;
  try {
    await notifyStaff({ userId, question, reason, branch, product });
  } catch (e) {
    console.error("notifyStaff failed", String(e));
  }
}

async function handleEvent(ev: WebhookEvent) {
  if (ev.type === "join") {
    const src = ev.source;
    const id = !src ? "" : src.type === "group" ? src.groupId : src.type === "room" ? src.roomId : "";
    console.log("joined, id:", id);
    await lineClient
      .replyMessage({
        replyToken: ev.replyToken,
        messages: [{ type: "text", text: `groupId ของกลุ่มนี้: ${id}` }],
      })
      .catch((e) => console.error("join reply failed", String(e)));
    return;
  }
  if (ev.type !== "message" || ev.source?.type !== "user" || !ev.source.userId) return;
  const userId = ev.source.userId;
  const token = ev.replyToken;
  if (!token) return;

  if (ev.message.type !== "text") {
    await reply(token, userId, DEFAULT_REPLY);
    await handoff(userId, `[${ev.message.type}]`, "non_text");
    return;
  }

  const text = ev.message.text;
  const data = await getBotData();
  if (!data) {
    await reply(token, userId, DEFAULT_REPLY);
    await handoff(userId, text, "sheet_error");
    return;
  }

  const history = getHistory(userId);
  const faqText = buildContext(data, text, history);
  const r = await askGemini(buildPrompt(faqText, history, text));

  // ไม่มีข้อมูล (not_found) → เงียบ ไม่ตอบลูกค้า แต่ยังแจ้งเจ้าหน้าที่
  const silent = r.intent === "not_found";
  if (!silent) await reply(token, userId, r.reply);
  pushHistory(userId, "user", text);
  if (!silent) pushHistory(userId, "admin", r.reply);

  if (r.errorReason) {
    await handoff(userId, text, r.errorReason === "max_tokens" ? "max_tokens" : "gemini_error");
  } else if (r.intent === "cut_branch" && r.inStock === true) {
    await handoff(userId, text, "cut_branch", r.branch, r.product);
  } else if (r.intent === "installment") {
    await handoff(userId, text, "installment");
  } else if (r.intent === "not_found") {
    await handoff(userId, text, "not_in_faq");
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.text();
    const sig = req.headers.get("x-line-signature") ?? "";
    if (!validateSignature(body, process.env.LINE_CHANNEL_SECRET ?? "", sig)) {
      console.warn("bad signature");
      return new Response("unauthorized", { status: 401 });
    }
    const events: WebhookEvent[] = JSON.parse(body).events ?? [];
    const results = await Promise.allSettled(events.map(handleEvent));
    results.forEach((r) => {
      if (r.status === "rejected") console.error("event failed", r.reason?.stack ?? String(r.reason));
    });
  } catch (e) {
    console.error("handler error", (e as Error)?.stack ?? String(e));
  }
  return new Response("ok", { status: 200 });
}

export async function GET() {
  return new Response("ok");
}
