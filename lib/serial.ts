// Serial No. ของสินค้า Apple: ใช้เดารุ่นไม่ได้ ต้องตรงทั้งเลขกับรายการของร้าน
// ห้ามบันทึกเลขลง log ประวัติแชท หรือชีท

// ตัดตัว S ที่บาร์โค้ดบนกล่อง Apple เติมไว้หน้าเลข 10 ตัว · ต้องตรงกับ Code.gs
export function normalizeSerial(value: string): string {
  const s = value.replace(/[\s-]/g, "").toUpperCase();
  return s.length === 11 && s.startsWith("S") ? s.slice(1) : s;
}

const FILLER =
  /\(s\)|serial\s*(?:no\b\.?|number)?|s\/n|ซีเรียล(?:นัมเบอร์)?|เลขเครื่อง|ตัดสด|หน้าร้าน|ราคา|เช็ค|เช็ก|ค่ะ|คะ|ครับ|คับ|จ้า|จ้ะ|นะ|หน่อย|[:：=,.()#?]/gi;
const KEYWORD = /serial|s\/n|ซีเรียล|เลขเครื่อง/i;
// ชื่อรุ่นที่พิมพ์ติดกัน เช่น iphone15pro ไม่ใช่ Serial
const MODEL_WORDS =
  /iphone|ipad|galaxy|samsung|oppo|vivo|realme|redmi|honor|infinix|tecno|reno|note|smart|spark|tab|pro|max|lite|plus|ultra|\d+gb|^sm[a-z]\d{3}/i;

// undefined = ไม่ใช่ข้อความส่ง Serial · cashCut = มีคำว่า "ตัดสด"
export function parseSerialText(text: string): { serial: string; cashCut: boolean } | undefined {
  const token = text.replace(FILLER, " ").trim();
  if (!/^[a-z0-9]{10,12}$/i.test(token)) return undefined;
  if ((token.match(/\d/g)?.length ?? 0) < 2 || (token.match(/[a-z]/gi)?.length ?? 0) < 2) {
    return undefined;
  }
  if (!KEYWORD.test(text) && MODEL_WORDS.test(token)) return undefined;
  return { serial: normalizeSerial(token), cashCut: text.includes("ตัดสด") };
}
