// ตัดสินว่ากล่องในรูปคือแถวไหนในชีทราคา
// ชื่อรุ่น (และรหัสรุ่น) ก่อน → ถ้ายังระบุไม่ได้ จึงใช้ SKU/เลขรุ่น Apple แล้วค่อย IMEI 8 หลักแรก
import type { BotData } from "./data";
import { matchBoxLabel, type BoxLabel } from "./image-match";
import { matchSku, matchTac } from "./sku-match";

export type BoxPrice = {
  row?: BotData["price"][number]; // ว่าง = ให้ถามรุ่นกลับ
  by?: "name" | "code";
  capacityUnread?: boolean;
  codeFound: boolean; // พบ SKU/เลขรุ่น/IMEI ในตาราง
};

export function findBoxPrice(data: BotData, label: BoxLabel): BoxPrice {
  const byName = matchBoxLabel(data.price, label);
  const byCode =
    matchSku(data.price, data.skus ?? [], label.sku, label) ??
    matchTac(data.price, data.tacs ?? [], label);
  const codeFound = !!byCode;

  if (byName) {
    // กันอ่านผิด: รหัสชี้คนละรุ่นหรือคนละความจุกับชื่อ → ถามกลับ
    if (byCode?.conflict || (byCode?.row && byCode.row !== byName.row)) return { codeFound };
    // รหัสยืนยันความจุให้แล้ว ไม่ต้องให้ลูกค้าเช็กซ้ำ
    const capacityUnread = byCode?.row ? !!byCode.capacityUnread : byName.capacityUnread;
    return { row: byName.row, by: "name", capacityUnread, codeFound };
  }
  return byCode?.row
    ? { row: byCode.row, by: "code", capacityUnread: byCode.capacityUnread, codeFound }
    : { codeFound };
}
