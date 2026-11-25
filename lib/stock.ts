// ตรวจคำตอบ "ไม่มี" ของ AI กับรายการสต๊อกจริงอีกชั้น (AI อาจอ่านรายการตกหล่น)
import { REQUISITION_REPLY } from "./constants";
import type { GeminiResult } from "./gemini";

// เทียบชื่อแบบไม่สนตัวพิมพ์ เว้นวรรค เครื่องหมาย และคำว่า APPLE นำหน้า
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/^\s*apple\s+/, "")
    .replace(/[^a-z0-9ก-๙+]/g, "");

// คืนชื่อในสต๊อกที่ "ตรงทั้งชื่อ" เท่านั้น (iPhone 17 ต้องไม่ไปตรงกับ iPhone 17 Pro)
export function findInStock(stock: string[], product: string): string | undefined {
  const want = normalize(product);
  return want ? stock.find((name) => normalize(name) === want) : undefined;
}

export function verifyStock(r: GeminiResult, stockList: string[], area?: string): GeminiResult {
  if (r.intent !== "stock" && r.intent !== "requisition") return r;
  const saidNo = r.inStock === false || (r.inStock === undefined && r.reply.includes("ไม่มีสินค้า"));
  if (!saidNo || !r.product) return r;
  const name = findInStock(stockList, r.product);
  if (!name) return r;

  console.warn(JSON.stringify({ note: "stock answer corrected", intent: r.intent, product: name }));
  const where = area ? ` ที่${area}` : "";
  const reply = r.intent === "requisition" ? REQUISITION_REPLY : `${name}${where} มีสินค้าค่ะ 😊`;
  return { ...r, reply, inStock: true, product: name };
}
