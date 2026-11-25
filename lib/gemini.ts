import { GoogleGenAI } from "@google/genai";
import {
  CUT_BRANCH_REPLY,
  DEFAULT_REPLY,
  MODEL,
  ORDER_CHECK_REPLY,
  REQUISITION_REPLY,
} from "./constants";
import { bankReply, FINANCE_QR_TEXT, isBankRow, type FaqRow, type PayType } from "./bank";

export interface GeminiResult {
  reply: string;
  intent: string;
  branch?: string;
  product?: string;
  inStock?: boolean;
  errorReason?: "max_tokens" | "gemini_error";
  sendFinanceQr?: boolean;
}

const TIMEOUT_MS = 12_000;
const MAX_REPLY = 1000;
let ai: GoogleGenAI | null = null;

function clean(text: string): string {
  let t = text
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .trim();
  if (t.length > MAX_REPLY) {
    const cut = t.slice(0, MAX_REPLY);
    const nl = cut.lastIndexOf("\n");
    t = (nl > 0 ? cut.slice(0, nl) : cut).trim();
  }
  return t;
}

// ระบบขัดข้อง → reply ว่าง (บอทไม่ตอบ เจ้าหน้าที่ตอบแทน)
const fail = (errorReason: "max_tokens" | "gemini_error"): GeminiResult => ({
  reply: "",
  intent: "error",
  errorReason,
});

// faq = แถวจากชีท FAQ เรียงตามลำดับข้อ (ข้อ 1 = index 0)
export async function askGemini(prompt: string, faq: FaqRow[]): Promise<GeminiResult> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("gemini timeout")), TIMEOUT_MS);
    });
    const call = ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        temperature: 1.0, // ห้ามลด (Gemini 3.x จะเพี้ยน)
        maxOutputTokens: 1024, // thinking + output รวมกัน ห้ามลด
        thinkingConfig: { thinkingLevel: "low" as never },
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            reply: { type: "string" },
            intent: {
              type: "string",
              enum: ["price", "stock", "cut_branch", "requisition", "product_ask", "product_not_found", "faq", "bank_account", "other"],
            },
            pay_type: { type: "string", enum: ["cash", "finance", "unknown"] },
            branch: { type: "string" },
            product: { type: "string" },
            in_stock: { type: "boolean" },
            faq_id: { type: "integer" },
          },
          required: ["reply", "intent"],
        },
      },
    });
    const response = await Promise.race([call, timeout]);

    const finishReason = response.candidates?.[0]?.finishReason;
    const u = response.usageMetadata;
    const base = {
      finishReason,
      thoughtsTokenCount: u?.thoughtsTokenCount,
      candidatesTokenCount: u?.candidatesTokenCount,
      promptTokenCount: u?.promptTokenCount,
      ms: Date.now() - started,
    };

    if (finishReason === "MAX_TOKENS") {
      console.warn(JSON.stringify({ ...base, intent: "error", note: "max_tokens" }));
      return fail("max_tokens");
    }
    if (finishReason !== "STOP") {
      console.error(JSON.stringify({ ...base, intent: "error", note: "bad finishReason" }));
      return fail("gemini_error");
    }

    const raw = response.text ?? "";
    let parsed: { reply?: string; intent?: string; branch?: string; product?: string; in_stock?: boolean; faq_id?: number; pay_type?: PayType };
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("gemini bad JSON:", raw.slice(0, 200));
      return fail("gemini_error");
    }
    if (!parsed.intent) return fail("gemini_error");
    // intent other = ไม่ตอบ · faq = ใช้คำตอบจากชีท · intent อื่นต้องมี reply
    if (!["other", "faq", "bank_account"].includes(parsed.intent) && !parsed.reply?.trim()) {
      return fail("gemini_error");
    }

    console.log(JSON.stringify({ ...base, intent: parsed.intent }));

    let reply: string;
    let sendFinanceQr = false;
    if (parsed.intent === "other") reply = "";
    // ส่งคำตอบจากชีทตรงตัว (ไม่ผ่าน clean) · เลขข้อไม่ถูกต้อง = เงียบ
    else if (parsed.intent === "bank_account") {
      reply = bankReply(faq, parsed.pay_type);
      if (parsed.pay_type === "finance") {
        sendFinanceQr = true;
        reply ||= FINANCE_QR_TEXT;
      }
    } else if (parsed.intent === "faq") {
      const row = faq[(parsed.faq_id ?? 0) - 1];
      // กันหลุด: AI เลือกแถวเลขบัญชีผ่าน faq โดยตรง → ต้องถามประเภทก่อนเสมอ
      reply = !row ? "" : isBankRow(row) ? bankReply(faq, "unknown") : row[2];
    }
    else if (parsed.intent === "product_not_found") reply = DEFAULT_REPLY;
    else if (parsed.intent === "cut_branch" && parsed.in_stock === true) reply = CUT_BRANCH_REPLY;
    else if (parsed.intent === "requisition" && parsed.in_stock === true) reply = REQUISITION_REPLY;
    else if (parsed.intent === "requisition" && parsed.in_stock === false) reply = ORDER_CHECK_REPLY;
    else reply = clean(parsed.reply ?? "");
    return {
      reply,
      intent: parsed.intent,
      branch: parsed.branch || undefined,
      product: parsed.product || undefined,
      inStock: parsed.in_stock,
      sendFinanceQr,
    };
  } catch (e) {
    console.error(`gemini error after ${Date.now() - started}ms:`, String(e));
    return fail("gemini_error");
  } finally {
    clearTimeout(timer);
  }
}
