import { validateSignature, webhook } from "@line/bot-sdk";
import { FINANCE_QR_PATH } from "@/lib/bank";
import { askGemini } from "@/lib/gemini";
import { verifyStock } from "@/lib/stock";
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

async function reply(replyToken: string, userId: string, text: string, imageUrl?: string) {
  const messages: Parameters<typeof lineClient.replyMessage>[0]["messages"] = [
    { type: "text", text },
  ];
  if (imageUrl) {
    messages.push({ type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl });
  }
  try {
    await lineClient.replyMessage({ replyToken, messages });
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
  // คำขอสินค้า (ตัดของ/เบิก/เช็กสั่ง) กันซ้ำเฉพาะรายการเดิม 10 นาที · อื่น ๆ 30 นาที
  const isRequest =
    reason === "cut_branch" || reason === "requisition" || reason === "order_check";
  const key = isRequest
    ? `${userId}|${reason}|${branch}|${product}`
    : `${userId}|${reason}`;
  if (!shouldNotify(key, isRequest ? 10 * MIN : 30 * MIN)) return;
  try {
    await notifyStaff({ userId, question, reason, branch, product });
  } catch (e) {
    console.error("notifyStaff failed", String(e));
  }
}

async function handleEvent(ev: WebhookEvent, baseUrl: string) {
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

  // โหมดทดสอบ: มี TEST_USER_IDS → ตอบเฉพาะคนในรายการ
  const testIds = (process.env.TEST_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (testIds.length && !testIds.includes(userId)) {
    console.log("skip non-test user", userId);
    return;
  }

  // รูป/สติกเกอร์/วิดีโอ/ไฟล์/เสียง/ตำแหน่ง → ไม่ตอบ ไม่แจ้ง
  if (ev.message.type !== "text") {
    console.log("skip non-text", ev.message.type);
    return;
  }

  const text = ev.message.text;
  const data = await getBotData();
  if (!data) {
    // ระบบขัดข้อง → ไม่ตอบ แต่แจ้งกลุ่มให้เจ้าหน้าที่ตอบแทน
    await handoff(userId, text, "sheet_error");
    return;
  }

  const history = getHistory(userId);
  const faqText = buildContext(data, text, history);
  const answer = await askGemini(buildPrompt(faqText, history, text), data.faq);
  const r = verifyStock(answer, data.warehouseStock);

  // reply ว่าง (intent other หรือ error) → ไม่ส่งอะไร
  if (r.reply) {
    const qr = r.sendFinanceQr ? `${baseUrl}${FINANCE_QR_PATH}` : undefined;
    await reply(token, userId, r.reply, qr);
  }
  pushHistory(userId, "user", text);
  if (r.reply) pushHistory(userId, "admin", r.reply);

  if (r.errorReason) {
    await handoff(userId, text, r.errorReason === "max_tokens" ? "max_tokens" : "gemini_error");
  } else if (r.intent === "cut_branch" && r.inStock === true) {
    await handoff(userId, text, "cut_branch", r.branch, r.product);
  } else if (r.intent === "requisition" && r.inStock !== undefined) {
    const reason = r.inStock ? "requisition" : "order_check";
    await handoff(userId, text, reason, undefined, r.product);
  } else if (r.intent === "product_not_found" || (r.intent === "bank_account" && !r.reply)) {
    // bank_account ที่ไม่มีคำตอบในชีท → บอทเงียบ แต่แจ้งกลุ่มให้เจ้าหน้าที่ตอบ
    await handoff(userId, text, "not_in_sheet");
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
    // LINE ต้องดึงรูปผ่าน https · ใช้โดเมนเดียวกับที่ LINE เรียก webhook เข้ามา
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
    const baseUrl = `https://${host}`;
    const results = await Promise.allSettled(events.map((ev) => handleEvent(ev, baseUrl)));
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
