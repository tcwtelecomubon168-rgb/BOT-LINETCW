import { lineClient } from "./line";
import { TZ } from "./constants";

export type HandoffReason =
  | "cut_branch"
  | "installment"
  | "not_in_faq"
  | "sheet_error"
  | "gemini_error"
  | "max_tokens"
  | "non_text";

const REASON_TH: Record<HandoffReason, string> = {
  cut_branch: "ขอตัดของสาขา",
  installment: "ถามเรื่องผ่อน",
  not_in_faq: "ไม่มีข้อมูลใน FAQ",
  sheet_error: "ดึงชีทไม่ได้",
  gemini_error: "AI ขัดข้อง/เกินเวลา",
  max_tokens: "AI ตอบไม่จบ",
  non_text: "ส่งสติกเกอร์/รูป",
};

export interface HandoffInput {
  userId: string;
  question: string;
  reason: HandoffReason;
  branch?: string;
  product?: string;
}

const TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function now(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("day")}/${g("month")}/${g("year")} ${g("hour")}:${g("minute")}`;
}

export async function notifyStaff(input: HandoffInput): Promise<void> {
  const { userId, question, reason, branch, product } = input;
  let displayName = "ไม่ทราบชื่อ";
  try {
    displayName = (await withTimeout(lineClient.getProfile(userId))).displayName || displayName;
  } catch (e) {
    console.warn("getProfile failed:", String(e));
  }

  const time = now();
  const text =
    reason === "cut_branch"
      ? `📦 ขอตัดของสาขา\nชื่อ: ${displayName}\nสาขา: ${branch ?? "-"}\nสินค้า: ${product ?? "-"}\nข้อความลูกค้า: ${question}\n⚠️ บอทเช็คจากชีทว่า "มี" กรุณายืนยันสต๊อกจริงก่อนตัด\nเวลา: ${time}`
      : `🔔 ลูกค้ารอติดต่อกลับ\nชื่อ: ${displayName}\nคำถาม: ${question}\nสาเหตุ: ${REASON_TH[reason]}\nเวลา: ${time}`;

  const tasks: Promise<unknown>[] = [];
  const labels: string[] = [];

  const groupId = process.env.STAFF_GROUP_ID;
  if (groupId) {
    labels.push("push group");
    tasks.push(
      withTimeout(lineClient.pushMessage({ to: groupId, messages: [{ type: "text", text }] })),
    );
  } else console.warn("STAFF_GROUP_ID not set, skip group push");

  const hook = process.env.HANDOFF_SHEET_WEBHOOK_URL;
  if (hook) {
    labels.push("sheet webhook");
    tasks.push(
      withTimeout(
        fetch(hook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          redirect: "follow",
          body: JSON.stringify({
            secret: process.env.HANDOFF_SECRET,
            displayName,
            userId,
            question,
            reason,
            branch,
            product,
          }),
        }).then((r) => {
          if (!r.ok) throw new Error(`status ${r.status}`);
        }),
      ),
    );
  } else console.warn("HANDOFF_SHEET_WEBHOOK_URL not set, skip sheet");

  const results = await Promise.allSettled(tasks);
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`handoff ${labels[i]} failed:`, String(r.reason));
  });
}
