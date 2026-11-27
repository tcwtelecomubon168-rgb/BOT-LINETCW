import type { BotData } from "./data";
import type { HistoryItem } from "./history";
import { pickRows, queryTokens } from "./match";

const NO_MODEL = "(ลูกค้ายังไม่ได้ระบุรุ่น)";
const NOT_FOUND = "(ไม่พบสินค้าที่ตรงกับคำถาม = ไม่มีสินค้า)";

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const AREAS: [string, RegExp][] = [
  ["อุบล", /อุบล/],
  ["สุรินทร์", /สุรินทร/],
  ["ร้อยเอ็ด", /ร้อยเอ็ด|ร้อยเอ็จ/],
];

// ลูกค้าถามสต๊อกของพื้นที่ไหน · ตัดของ/เบิก/สาขา ใช้กฎเดิม · ข้อความตอบต่อสั้น ๆ ใช้พื้นที่จากข้อความก่อนหน้า
export function detectArea(text: string, history: HistoryItem[]): string | undefined {
  const previous = history.filter((h) => h.role === "user").map((h) => h.text).reverse();
  let tokens: string[] = [];
  for (const m of [text, ...previous]) {
    if (/ตัดของ|ตัดสต๊อก|เบิก|สาขา|bigc|lotus|central/i.test(m)) return undefined;
    const found = AREAS.filter(([, re]) => re.test(m));
    if (found.length) return found.length === 1 ? found[0][0] : undefined;
    tokens = tokens.concat(queryTokens(m));
    if (tokens.length >= 2) break;
  }
  return undefined;
}

const csv = (header: string[], rows: string[][]) =>
  [header, ...rows].map((r) => r.map(cell).join(",")).join("\n");

// คัดข้อมูลที่เกี่ยวกับคำถาม → ข้อความสำหรับ <faq> (สต๊อกสาขา ~2,500 แถว ส่งหมดไม่ได้)
export function buildContext(
  data: BotData,
  text: string,
  history: HistoryItem[],
  excludeBranch?: string,
) {
  let tokens = queryTokens(text);
  if (tokens.length < 2) {
    // ข้อความสั้น (เช่น "256 สีดำ", "มีสีอะไรบ้าง") → ย้อนรวม token จากข้อความลูกค้าก่อนหน้า
    // จากใหม่ไปเก่า จนครบอย่างน้อย 2 token (กันชื่อรุ่นหายเมื่อคุยต่อกันหลายข้อความ)
    for (const h of [...history].reverse()) {
      if (h.role !== "user") continue;
      tokens = Array.from(new Set([...tokens, ...queryTokens(h.text)]));
      if (tokens.length >= 2) break;
    }
  }

  const areaName = detectArea(text, history);
  const areaStock = areaName ? data.warehouses?.[areaName] : undefined;
  if (areaName && !areaStock) {
    console.error(`no stock list for area "${areaName}" (อัปเดต Code.gs หรือยัง)`);
  }
  const area = areaStock ? areaName : undefined;
  const stockList = areaStock ?? data.warehouseStock;
  const warehouse = pickRows(stockList, (r) => r, tokens, 60);
  // ลูกค้าเลือกโซนแล้ว → ตัดแถวของอีกโซนออก กัน AI สับสนชื่อที่คล้ายกัน
  const branchRows = excludeBranch
    ? data.branchStock.filter((r) => r[0] !== excludeBranch)
    : data.branchStock;
  const branch = pickRows(branchRows, (r) => r[1], tokens, 150);

  const stockBody = !tokens.length ? NO_MODEL : warehouse.length ? warehouse.join("\n") : NOT_FOUND;
  const branchBody = !tokens.length
    ? NO_MODEL
    : branch.length
      ? csv(["สาขา", "ชื่อสินค้า"], branch)
      : NOT_FOUND;

  // FAQ ส่งแค่ ข้อ/หมวด/คำถาม — ไม่ส่งคำตอบ (โค้ดดึงคำตอบจากชีทส่งเอง AI จึงพิมพ์เลขบัญชีเองไม่ได้)
  const faqRows = data.faq.map(([category, question], i) => [String(i + 1), category, question]);

  const out = [
    `<sheet name="FAQ">
${csv(["ข้อ", "หมวด", "คำถาม"], faqRows)}
</sheet>`,
    `<sheet name="ราคา">\n${csv(["ยี่ห้อ", "รุ่น", "ราคาตัดสด", "ราคาปลีก"], data.price)}\n</sheet>`,
    `<sheet name="สต๊อก"${area ? ` พื้นที่="${area}"` : ""}>\n${stockBody}\n</sheet>`,
    `<sheet name="สต๊อกสาขา">\n${branchBody}\n</sheet>`,
  ].join("\n");

  console.log(
    JSON.stringify({
      tokens,
      area,
      warehouseRows: warehouse.length,
      branchRows: branch.length,
      chars: out.length,
    }),
  );
  return { text: out, stockList, area };
}
