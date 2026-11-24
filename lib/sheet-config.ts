export type SheetKind = "faq" | "price" | "branchStock" | "warehouseStock";

export interface SheetConfig {
  kind: SheetKind;
  // ชื่อหัวคอลัมน์จริงในชีท (แก้ที่นี่ที่เดียวเมื่อหัวตารางต่างจากนี้)
  columns: Record<string, string>;
}

export const SHEET_CONFIG: Record<string, SheetConfig> = {
  FAQ: {
    kind: "faq",
    columns: { category: "หมวดหมู่", question: "คำถาม", answer: "คำตอบ", enabled: "เปิดใช้" },
  },
  ราคา: {
    kind: "price",
    columns: { model: "รุ่น", cash: "ราคาตัดสด", retail: "ราคาปลีก" },
  },
  สต๊อกสาขา: {
    kind: "branchStock",
    columns: { model: "รุ่น", branch: "สาขา", qty: "จำนวน" },
  },
  สต๊อกคลังอุบล: { kind: "warehouseStock", columns: { model: "รุ่น", qty: "จำนวน" } },
  สต๊อกคลังสุรินทร์: { kind: "warehouseStock", columns: { model: "รุ่น", qty: "จำนวน" } },
  สต๊อกคลังร้อยเอ็ด: { kind: "warehouseStock", columns: { model: "รุ่น", qty: "จำนวน" } },
};
