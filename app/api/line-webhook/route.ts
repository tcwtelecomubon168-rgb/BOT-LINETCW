import { validateSignature, webhook } from "@line/bot-sdk";
import { bankReply, detectPayType, FINANCE_QR_PATH, FINANCE_QR_TEXT } from "@/lib/bank";
import { askGemini, type GeminiResult } from "@/lib/gemini";
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
  // เรื่องเกี่ยวกับสินค้า กันซ้ำเฉพาะรายการเดิม 10 นาที · อื่น ๆ 30 นาที
  const isRequest = [
    "cut_branch",
    "requisition",
    "order_check",
    "out_of_stock",
    "not_in_sheet",
    "special_order",
  ].includes(reason);
  const key = isRequest
    ? `${userId}|${reason}|${branch}|${product ?? question}`
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
    // ระบบขัดข้อง → ไม่ตอบ บันทึกลงชีทอย่างเดียว (ไม่ส่งเข้ากลุ่ม)
    await handoff(userId, text, "sheet_error");
    return;
  }

  const history = getHistory(userId);
  const payType = detectPayType(text, history);
  let r: GeminiResult;
  if (payType) {
    console.log(JSON.stringify({ intent: "bank_account", payType, by: "code" }));
    const bank = bankReply(data.faq, payType);
    r = {
      intent: "bank_account",
      reply: payType === "finance" ? bank || FINANCE_QR_TEXT : bank,
      sendFinanceQr: payType === "finance",
    };
  } else {
    const context = buildContext(data, text, history);
    const answer = await askGemini(buildPrompt(context.text, history, text), data.faq);
    // ตรวจกับรายการเดียวกับที่ส่งให้ AI (รวม 3 คลัง หรือเฉพาะพื้นที่ที่ถาม) · เบิกใช้รายการรวมเสมอ
    r =
      answer.intent === "requisition" && context.area
        ? answer
        : verifyStock(answer, context.stockList, context.area);
  }

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
  } else if ((r.intent === "stock" || r.intent === "cut_branch") && r.inStock === false) {
    await handoff(userId, text, "out_of_stock", r.branch, r.product);
  } else if (r.intent === "product_not_found") {
    await handoff(userId, text, "not_in_sheet", undefined, r.product);
  } else if (r.intent === "special_order") {
    await handoff(userId, text, "special_order", undefined, r.product);
  } else if (r.intent === "app_issue") {
    await handoff(userId, text, "app_issue");
  } else if (r.intent === "bank_account" && !r.reply) {
    // ไม่มีคำตอบบัญชีในชีท → บอทเงียบ บันทึกลงชีท
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
