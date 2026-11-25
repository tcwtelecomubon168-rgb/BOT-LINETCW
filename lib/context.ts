import type { BotData } from "./data";
import type { HistoryItem } from "./history";
import { pickRows, queryTokens } from "./match";

const NO_MODEL = "(ลูกค้ายังไม่ได้ระบุรุ่น)";
const NOT_FOUND = "(ไม่พบสินค้าที่ตรงกับคำถาม = ไม่มีสินค้า)";

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (header: string[], rows: string[][]) =>
  [header, ...rows].map((r) => r.map(cell).join(",")).join("\n");

// คัดข้อมูลที่เกี่ยวกับคำถาม → ข้อความสำหรับ <faq> (สต๊อกสาขา ~2,500 แถว ส่งหมดไม่ได้)
export function buildContext(data: BotData, text: string, history: HistoryItem[]): string {
  let tokens = queryTokens(text);
  if (tokens.length < 2) {
    // ข้อความสั้น (เช่น "256 สีดำ") → เอา token จากข้อความลูกค้าก่อนหน้าล่าสุดที่ระบุสินค้า
    // (ข้ามข้อความที่ไม่มี token เช่น "อำนาจ สีเขียว" ไม่งั้นพิมพ์ซ้ำแล้วบอทลืมรุ่น)
    const prev = [...history]
      .reverse()
      .filter((h) => h.role === "user")
      .map((h) => queryTokens(h.text))
      .find((t) => t.length > 0);
    if (prev) tokens = Array.from(new Set([...tokens, ...prev]));
  }

  const warehouse = pickRows(data.warehouseStock, (r) => r, tokens, 60);
  const branch = pickRows(data.branchStock, (r) => r[1], tokens, 150);

  const stockBody = !tokens.length ? NO_MODEL : warehouse.length ? warehouse.join("\n") : NOT_FOUND;
  const branchBody = !tokens.length
    ? NO_MODEL
    : branch.length
      ? csv(["สาขา", "ชื่อสินค้า"], branch)
      : NOT_FOUND;

  const out = [
    `<sheet name="ราคา">\n${csv(["ยี่ห้อ", "รุ่น", "ราคาตัดสด", "ราคาปลีก"], data.price)}\n</sheet>`,
    `<sheet name="สต๊อก">\n${stockBody}\n</sheet>`,
    `<sheet name="สต๊อกสาขา">\n${branchBody}\n</sheet>`,
  ].join("\n");

  console.log(
    JSON.stringify({
      tokens,
      warehouseRows: warehouse.length,
      branchRows: branch.length,
      chars: out.length,
    }),
  );
  return out;
}
