// พิมพ์แค่ชื่อรุ่น/ความจุ โดยไม่ได้ถามอะไร → บอทเงียบ (กฎร้าน · AI เคยตอบเอง)
// ยกเว้นแอดมินเพิ่งถามกลับ แล้วลูกค้าพิมพ์ชื่อรุ่นมาตอบ
import type { HistoryItem } from "./history";

const BRAND =
  /apple|iphone|ipad|samsung|galaxy|oppo|reno|vivo|realme|honor|xiaomi|redmi|infinix|tecno|zte|nubia|benco|nokia|tcl|wiko/i;
const CAPACITY = /\d+\s*(?:gb)?\s*[+/]\s*\d+|\d+\s*(?:gb|tb)(?![a-z])/i;
// คำไทยที่เป็นส่วนของสเปค ไม่นับเป็นคำถาม
const SPEC_WORDS = /แรม|รอม|ความจุ|สี?(?:ดำ|ขาว|ฟ้า|น้ำเงิน|ม่วง|เขียว|ชมพู|ทอง|เงิน|เทา|ส้ม|แดง|เหลือง|ครีม|น้ำตาล)/g;
const ADMIN_ASKED = /ไหน|ไหม|อะไร|แจ้งรุ่น|เลือก/;

export function isBareProduct(text: string, history: HistoryItem[]): boolean {
  const t = text.trim();
  if (!t || t.length > 60) return false;
  const rest = t.replace(SPEC_WORDS, " ");
  // มีข้อความไทยอื่น หรือเป็นคำถามภาษาอังกฤษ → ให้เข้าขั้นตอนปกติ
  if (/[ก-๙]/.test(rest) || /\?|price|stock|how much/i.test(rest)) return false;
  if (!BRAND.test(rest) && !CAPACITY.test(rest)) return false;
  const lastAdmin = [...history].reverse().find((h) => h.role === "admin");
  return !(lastAdmin && ADMIN_ASKED.test(lastAdmin.text));
}
