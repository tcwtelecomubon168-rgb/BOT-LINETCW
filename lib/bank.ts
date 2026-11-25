// เรื่องเลขบัญชี: ต้องรู้ก่อนว่าตัดสดหรือขายไฟแนนซ์ แล้ว "โค้ด" เป็นคนเลือกคำตอบจากชีท FAQ
export type PayType = "cash" | "finance" | "unknown";
export type FaqRow = [string, string, string]; // [หมวด, คำถาม, คำตอบ]

export const BANK_ASK_REPLY = "ลูกค้าขายไฟแนนซ์ หรือ ตัดสด ครับ";

// รูป QR สำหรับขายไฟแนนซ์ (ไฟล์ใน public/ — เปลี่ยนรูปได้ด้วยการ push เท่านั้น ไม่อ่านลิงก์จากชีท)
export const FINANCE_QR_PATH = "/qr-finance.jpg";
// ใช้เมื่อชีท FAQ ยังไม่มีแถวคำตอบสำหรับไฟแนนซ์
export const FINANCE_QR_TEXT = "กรณีขายไฟแนนซ์ สแกน QR Code ด้านล่างได้เลยครับ";

const KEYWORD = { cash: "ตัดสด", finance: "ไฟแนนซ์" } as const;

// แถว FAQ เรื่องโอนเงิน/บัญชี (ดูจากหมวดและคำถาม)
export const isBankRow = ([category, question]: FaqRow) => /โอน|บัญชี/.test(`${category} ${question}`);

// คืน "" = ไม่มีคำตอบที่ชัดเจน (บอทเงียบและแจ้งเจ้าหน้าที่)
export function bankReply(faq: FaqRow[], payType: PayType | undefined): string {
  if (payType !== "cash" && payType !== "finance") return BANK_ASK_REPLY;
  const rows = faq.filter(isBankRow);
  const pick = (text: (r: FaqRow) => string) => {
    const hit = rows.filter((r) => text(r).includes(KEYWORD[payType]));
    return hit.length === 1 ? hit[0] : hit.length === 0 ? undefined : null;
  };
  // ดูคำว่า ตัดสด/ไฟแนนซ์ จากหมวดและคำถามก่อน ถ้าไม่มีเลยจึงดูในคำตอบ · ตรงหลายแถว = ไม่เดา
  let row = pick((r) => `${r[0]} ${r[1]}`);
  if (row === undefined) row = pick((r) => r[2]);
  return row ? row[2] : "";
}
