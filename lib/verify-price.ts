// ตรวจตัวเลขราคาในคำตอบของ AI กับชีทราคา (AI เคยหยิบราคาของรุ่นอื่นมาตอบ)
// หาแถวจากชื่อรุ่นในคำตอบ แล้วใช้ตัวเลขจากชีทเสมอ · หาแถวไม่ได้ = ไม่ส่งราคานั้น
import type { BotData } from "./data";
import type { GeminiResult } from "./gemini";
import { parseSpec, ramFits } from "./image-match";

type PriceRow = BotData["price"][number];

export const PRICE_RECHECK_REPLY = "รบกวนคุณลูกค้าแจ้งรุ่นและความจุที่ต้องการทราบราคาอีกครั้งนะคะ";

// ตัวเลขที่นับเป็นราคา (กันไปจับเลขรุ่น/ความจุ) มีสองแบบ
//  ก) ตามหลัง "ตัดสด"/"ปลีก" โดยคั่นด้วยข้อความไทยหรือเครื่องหมายเท่านั้น → กลุ่ม 1-3
//  ข) ตามด้วย "บาท" หรือ ".-" → กลุ่ม 4
const NUM = String.raw`(?<![\dA-Za-z,+/])(\d{1,3}(?:,\d{3})+|\d{3,6})(?![\d,]|\s*(?:[Gg][Bb]|[Tt][Bb]|[+/]\s*\d))`;
const AMOUNT = new RegExp(
  String.raw`(ตัดสด|ปลีก)([^\dA-Za-z\n]{0,15}?)${NUM}|${NUM}(?=\s*(?:บาท|\.-))`,
  "g",
);

const squash = (s: string) => s.toLowerCase().replace(/[\s"'”“]/g, "");
const num = (s: string) => Number(s.replace(/,/g, ""));

export function findPriceRow(price: PriceRow[], name: string): PriceRow | undefined {
  // 1) ชื่อในชีทปรากฏตรงตัว → เอาชื่อที่ยาวที่สุด
  const text = squash(name);
  const exact = price.filter((r) => text.includes(squash(r[1])));
  if (exact.length) {
    const longest = Math.max(...exact.map((r) => squash(r[1]).length));
    const best = exact.filter((r) => squash(r[1]).length === longest);
    if (new Set(best.map((r) => `${r[2]}|${r[3]}`)).size === 1) return best[0];
  }
  // 2) เทียบรุ่น ความจุ และ 4G/5G (คำตอบอาจเขียนชื่อต่างจากชีทเล็กน้อย)
  const want = parseSpec(name.replace(/[^\x20-\x7e]+/g, " "));
  if (!want.key) return undefined;
  let found = price
    .map((row) => ({ row, spec: parseSpec(row[1]) }))
    .filter(
      ({ spec }) =>
        spec.key === want.key &&
        (!want.storage || !spec.storage || spec.storage === want.storage) &&
        (!want.ram || !spec.ram || ramFits(spec, want.ram)),
    );
  if (want.network) {
    const same = found.filter((f) => f.spec.network === want.network);
    found = same.length ? same : found.filter((f) => !f.spec.network);
  }
  return found.length === 1 ? found[0].row : undefined;
}

export function verifyPrice(r: GeminiResult, price: PriceRow[]): GeminiResult {
  // คำตอบจากชีท FAQ/บัญชี ส่งตรงตัว ไม่ต้องตรวจ
  if (!r.reply || r.intent === "faq" || r.intent === "bank_account") return r;

  let blocked = false;
  let fixed = 0;
  let previous = ""; // บรรทัดก่อนหน้า เผื่อชื่อรุ่นอยู่คนละบรรทัดกับราคา
  const lines = r.reply.split("\n").map((line) => {
    const amounts = Array.from(line.matchAll(AMOUNT));
    // บรรทัดที่ไม่ได้พูดถึงราคา (ไม่มีคำว่า ราคา/ตัดสด/ปลีก/บาท) ไม่ต้องตรวจ
    if (!amounts.length || !/ราคา|ตัดสด|ปลีก|บาท/.test(line)) {
      previous = line;
      return line;
    }
    // หลายรุ่นในบรรทัดเดียว แยกไม่ได้ว่าราคาไหนของรุ่นไหน
    const labels = amounts.map((m) => m[1]).filter(Boolean);
    if (new Set(labels).size !== labels.length || amounts.length > 2) {
      blocked = true;
      return line;
    }
    // ชื่อรุ่นมักอยู่ก่อนคำว่าราคา · ถ้าไม่มี ดูส่วนที่เหลือของบรรทัด แล้วจึงบรรทัดก่อนหน้า
    const cut = line.search(/ราคา|ตัดสด|ปลีก/);
    const head = line.slice(0, cut >= 0 ? cut : amounts[0].index).trim();
    const rest = line.replace(AMOUNT, "$1$2 ");
    const name =
      [head, rest].find((t) => /[a-z]/i.test(t)) ?? (previous || r.product || "");
    const row = findPriceRow(price, name);
    if (!row) {
      blocked = true;
      return line;
    }
    return line.replace(AMOUNT, (...m: unknown[]) => {
      const whole = m[0] as string;
      const label = m[1] as string | undefined;
      const gap = (m[2] as string | undefined) ?? "";
      const value = (m[3] ?? m[4]) as string;
      let correct: string;
      if (label === "ตัดสด") correct = row[2];
      else if (label === "ปลีก") correct = row[3];
      else if ([row[2], row[3]].some((p) => num(p) === num(value))) return whole;
      else {
        blocked = true; // ตัวเลขไม่ระบุว่าราคาอะไร และไม่ตรงชีท
        return whole;
      }
      if (num(correct) === num(value)) return whole;
      fixed++;
      return `${label}${gap}${correct}`;
    });
  });

  if (blocked) {
    console.warn(JSON.stringify({ intent: "price_check", result: "blocked" }));
    return { reply: PRICE_RECHECK_REPLY, intent: "product_ask" };
  }
  if (fixed) console.warn(JSON.stringify({ intent: "price_check", result: "fixed", fixed }));
  return fixed ? { ...r, reply: lines.join("\n") } : r;
}
