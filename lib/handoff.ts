import { lineClient } from "./line";
import { TZ } from "./constants";

export type HandoffReason =
  | "cut_branch"
  | "requisition"
  | "order_check"
  | "not_in_sheet"
  | "sheet_error"
  | "gemini_error"
  | "max_tokens";

const REASON_TH: Record<HandoffReason, string> = {
  cut_branch: "ขอตัดของสาขา",
  requisition: "ขอเบิกสินค้า",
  order_check: "ตรวจสอบการสั่งสินค้า",
  not_in_sheet: "ไม่มีข้อมูลสินค้าในชีท",
  sheet_error: "ดึงชีทไม่ได้",
  gemini_error: "AI ขัดข้อง/เกินเวลา",
  max_tokens: "AI ตอบไม่จบ",
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
  const titles: Partial<Record<HandoffReason, string>> = {
    cut_branch: "📦 ขอตัดของสาขา",
    requisition: "📦 ขอเบิกสินค้า",
    order_check: "🛒 ขอตรวจสอบการสั่งสินค้า",
  };
  // คำขอที่บอทรู้สินค้าครบแล้ว ใช้ชื่อสินค้าเต็ม (ข้อความล่าสุดอาจมีแค่ สาขา/สี)
  let request = question;
  if (product && reason === "cut_branch") request = `ขอตัดของ ${product}`;
  if (product && (reason === "requisition" || reason === "order_check")) request = `ขอเบิก ${product}`;

  const text = [
    titles[reason] ?? "🔔 ลูกค้ารอติดต่อกลับ (บอทตอบไม่ได้)",
    `ชื่อ: ${displayName}`,
    `ลูกค้า: ${request}`,
    `สาขา: ${branch ?? "-"}`,
    `เวลา: ${time}`,
  ].join("\n");

  const tasks: Promise<unknown>[] = [];
  const labels: string[] = [];

  const groupId = process.env.STAFF_GROUP_ID;
  if (groupId) {
    labels.push("push group");
    tasks.push(
      withTimeout(lineClient.pushMessage({ to: groupId, messages: [{ type: "text", text }] })),
    );
  } else console.warn("STAFF_GROUP_ID not set, skip group push");

  const hook = process.env.APPS_SCRIPT_URL;
  if (hook) {
    labels.push("sheet webhook");
    tasks.push(
      withTimeout(
        fetch(hook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          redirect: "follow",
          body: JSON.stringify({
            key: process.env.APPS_SCRIPT_KEY,
            displayName,
            userId,
            question,
            reason,
            branch,
            product,
          }),
        }).then(async (r) => {
          if (!r.ok) throw new Error(`status ${r.status}`);
          const j = await r.json().catch(() => null);
          if (!j?.ok) throw new Error(`apps script replied ${JSON.stringify(j)}`);
        }),
      ),
    );
  } else console.warn("APPS_SCRIPT_URL not set, skip sheet");

  const results = await Promise.allSettled(tasks);
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`handoff ${labels[i]} failed:`, String(r.reason));
  });
}
