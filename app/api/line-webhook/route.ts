import { validateSignature, webhook } from "@line/bot-sdk";
import { bankReply, detectPayType, FINANCE_QR_PATH, FINANCE_QR_TEXT } from "@/lib/bank";
import { askGemini, type GeminiResult } from "@/lib/gemini";
import { verifyStock } from "@/lib/stock";
import { verifyCutBranch } from "@/lib/cut-branch";
import { PRICE_LIST_REPLY } from "@/lib/constants";
import { asksPriceList } from "@/lib/price-list";
import { asksCashPriceWithoutModel, CASH_PRICE_ASK_REPLY } from "@/lib/cash-price";
import { notifyStaff, type HandoffReason } from "@/lib/handoff";
import { lineClient } from "@/lib/line";
import { buildContext } from "@/lib/context";
import { getBotData } from "@/lib/data";
import { getHistory, pushHistory } from "@/lib/history";
import { buildPrompt } from "@/lib/prompt";
import { findBoxPrice } from "@/lib/box-price";
import {
  capacityPriceReply,
  IMEI_INVALID_REPLY,
  imeiPriceReply,
  parseImeiText,
  rememberTacs,
  setCapacityOptions,
  takeCapacityAnswer,
  takeTacs,
} from "@/lib/imei-text";
import { chosenZone, needsZoneAsk, ZONE_ASK_REPLY, ZONE_BRANCHES } from "@/lib/kantharalak";
import {
  imagePriceEnabled,
  isBareCashCut,
  readBoxLabel,
  rememberImage,
  takeImages,
} from "@/lib/image-price";

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

async function replyFromImage(token: string, userId: string, text: string, images: string[]) {
  const data = await getBotData();
  if (!data) {
    await handoff(userId, text, "sheet_error");
    return;
  }
  const label = await readBoxLabel(images, !!data.tacs?.length);
  const found = label ? findBoxPrice(data, label) : undefined;
  const row = found?.row;
  console.log(
    JSON.stringify({
      intent: "price_from_image",
      images: images.length,
      label,
      matched: row?.[1],
      matchedBy: found?.by,
      capacityUnread: found?.capacityUnread,
      codeFound: found?.codeFound,
      skuRows: data.skus?.length ?? 0,
      tacRows: data.tacs?.length ?? 0,
    }),
  );
  const note = found?.capacityUnread
    ? "แอดมินอ่านความจุจากรูปได้ไม่ครบ รบกวนเช็กความจุบนกล่อง หากไม่ตรง แจ้งได้เลยนะคะ"
    : "หากไม่ตรงรุ่น แจ้งได้เลยนะคะ";
  const answer = row
    ? `จากรูป: ${row[1]} ราคาตัดสด ${row[2]} บาท ค่ะ 😊
${note}`
    : CASH_PRICE_ASK_REPLY;
  await reply(token, userId, answer);
  // ใส่ชื่อรุ่นในประวัติ เพื่อให้คำถามต่อเนื่องรู้ว่าคุยรุ่นไหน
  pushHistory(userId, "user", row ? `ตัดสด ${row[1]}` : text);
  pushHistory(userId, "admin", answer);
}

async function replyFromImei(token: string, userId: string, tacs: string[]) {
  // ข้อความที่บันทึกใช้คำแทน ห้ามใช้ข้อความจริงเพราะมีเลข IMEI
  const asked = "ตัดสด (ส่ง IMEI)";
  const data = await getBotData();
  if (!data) {
    await handoff(userId, asked, "sheet_error");
    return;
  }
  const result = imeiPriceReply(data, tacs);
  console.log(
    JSON.stringify({
      intent: "price_from_imei",
      tacs,
      matched: result.row?.[1],
      options: result.options?.length,
      tacRows: data.tacs?.length ?? 0,
    }),
  );
  if (result.options) setCapacityOptions(userId, result.options);
  await reply(token, userId, result.reply);
  pushHistory(userId, "user", result.row ? `ตัดสด ${result.row[1]}` : asked);
  pushHistory(userId, "admin", result.reply);
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
    // รูป: จำแค่ messageId เผื่อมีคำว่า "ตัดสด" ตามมา (ต้องจำก่อน await ใด ๆ)
    if (ev.message.type === "image" && imagePriceEnabled(userId)) {
      rememberImage(userId, ev.message.id);
      takeTacs(userId); // ส่งรูปใหม่ → ยกเลิกเลข IMEI ที่รออยู่
    }
    console.log("skip non-text", ev.message.type, ev.message.type === "image" ? userId : "");
    return;
  }

  const text = ev.message.text;

  // พิมพ์เลข IMEI + "ตัดสด" → โค้ดค้นราคาเอง (ต้องดักก่อนขั้นตอนอื่น ไม่ให้เลขไปถึง AI)
  const imei = parseImeiText(text);
  if (imei) {
    if (!imei.cashCut) {
      // มีแต่เลข → ยังไม่ตอบ รอคำว่า "ตัดสด"
      if (imei.tacs.length) rememberTacs(userId, imei.tacs);
      console.log("imei without cash-cut word: waiting");
    } else if (imei.tacs.length) {
      takeTacs(userId);
      await replyFromImei(token, userId, imei.tacs);
    } else {
      await reply(token, userId, IMEI_INVALID_REPLY);
    }
    return;
  }

  // ส่ง IMEI มาก่อน แล้วพิมพ์ "ตัดสด" ตามมา
  if (isBareCashCut(text, getHistory(userId))) {
    const tacs = takeTacs(userId);
    if (tacs) {
      takeImages(userId); // ใช้ IMEI แล้ว ไม่ใช้รูปค้างกับข้อความถัดไป
      await replyFromImei(token, userId, tacs);
      return;
    }
  }

  // ตอบความจุที่ถามไว้หลังส่ง IMEI
  const picked = takeCapacityAnswer(userId, text);
  if (picked) {
    const answer = capacityPriceReply(picked);
    console.log(JSON.stringify({ intent: "price_from_imei", capacityPicked: picked[1] }));
    await reply(token, userId, answer);
    pushHistory(userId, "user", `ตัดสด ${picked[1]}`);
    pushHistory(userId, "admin", answer);
    return;
  }

  // ขอใบราคา → ตอบได้ทันทีโดยไม่ต้องใช้ข้อมูลชีทหรือ AI และไม่แจ้งกลุ่ม
  if (asksPriceList(text)) {
    console.log(JSON.stringify({ intent: "price_list", by: "code" }));
    await reply(token, userId, PRICE_LIST_REPLY);
    pushHistory(userId, "user", text);
    pushHistory(userId, "admin", PRICE_LIST_REPLY);
    return;
  }

  // ส่งรูปกล่องแล้วพิมพ์ "ตัดสด" → อ่านฉลาก เทียบชีทราคา
  if (imagePriceEnabled(userId) && isBareCashCut(text, getHistory(userId))) {
    const images = takeImages(userId);
    if (images.length) {
      await replyFromImage(token, userId, text, images);
      return;
    }
    console.log("price_from_image: no recent image");
  }

  if (asksCashPriceWithoutModel(text, getHistory(userId))) {
    console.log(JSON.stringify({ intent: "product_ask", topic: "cash_price", by: "code" }));
    await reply(token, userId, CASH_PRICE_ASK_REPLY);
    pushHistory(userId, "user", text);
    pushHistory(userId, "admin", CASH_PRICE_ASK_REPLY);
    return;
  }

  // ตัดของสาขากันทรลักษ์โดยไม่บอกโซน → ถามโซนก่อน
  if (needsZoneAsk(text, getHistory(userId))) {
    console.log(JSON.stringify({ intent: "product_ask", topic: "kantharalak_zone", by: "code" }));
    await reply(token, userId, ZONE_ASK_REPLY);
    pushHistory(userId, "user", text);
    pushHistory(userId, "admin", ZONE_ASK_REPLY);
    return;
  }

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
    const zone = chosenZone(text, history);
    const otherBranch = zone && ZONE_BRANCHES[zone === "event" ? "inside" : "event"];
    const context = buildContext(data, text, history, otherBranch);
    // บอก AI ว่าลูกค้าเลือกสาขาไหน (ข้อความจริงอาจมีแค่ "1" หรือ "2")
    const question = zone ? `${text} (สาขาที่เลือก: ${ZONE_BRANCHES[zone]})` : text;
    const answer = await askGemini(buildPrompt(context.text, history, question), data.faq);
    // ตรวจกับรายการเดียวกับที่ส่งให้ AI (รวม 3 คลัง หรือเฉพาะพื้นที่ที่ถาม) · เบิกใช้รายการรวมเสมอ
    r =
      answer.intent === "requisition" && context.area
        ? answer
        : verifyStock(answer, context.stockList, context.area);
    // คำตอบเรื่องสาขา ตรวจและเขียนใหม่จากข้อมูลสต๊อกสาขาจริง
    r = verifyCutBranch(r, text, history, data.branchStock);
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
