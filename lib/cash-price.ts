// ถามราคาตัดสดโดยไม่บอกรุ่น → โค้ดถามกลับเอง ไม่ให้ถูกเงียบ
import type { HistoryItem } from "./history";
import { queryTokens } from "./match";

export const CASH_PRICE_ASK_REPLY = "คุณลูกค้าต้องการราคาตัดสดของรุ่นและความจุไหนคะ";

export function asksCashPriceWithoutModel(text: string, history: HistoryItem[]): boolean {
  const asksCashPrice = text.includes("ตัดสด") && /ราคา|เท่าไหร่|เท่าไร|กี่บาท/.test(text);
  if (!asksCashPrice || /โอน|บัญชี|แล้ว/.test(text)) return false;
  // มีรุ่นในข้อความนี้ หรือกำลังคุยรุ่นอยู่ → ให้ AI ตอบตามปกติ
  if (queryTokens(text).length) return false;
  return !history.some((h) => h.role === "user" && queryTokens(h.text).length > 0);
}
