// ใช้ IMEI บอกรุ่นเท่านั้น: ตรวจเลขครบ 15 หลัก แล้วเก็บแค่ 8 หลักแรก (TAC)
// ห้ามบันทึกหรือส่งต่อเลขเต็ม เพราะใช้ระบุเครื่องแต่ละเครื่องได้

// เลขตรวจสอบ (Luhn) ช่วยจับการอ่านผิดส่วนใหญ่
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

export function tacsFrom(imeis: unknown): string[] {
  if (!Array.isArray(imeis)) return [];
  const tacs = imeis
    .map((v) => String(v).replace(/[\s-]/g, "").split("/")[0])
    .filter((v) => /^\d{15}$/.test(v) && !/^0+$/.test(v) && luhn(v))
    .map((v) => v.slice(0, 8));
  return Array.from(new Set(tacs));
}

// ลบเลขยาว (รวมแบบมีเว้นวรรคหรือขีดคั่น) ก่อนนำข้อความไปใช้หรือบันทึก log
export const stripLongNumbers = (text: string) => text.replace(/\d(?:[\s-]?\d){7,}/g, "");
