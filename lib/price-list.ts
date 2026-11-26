// ลูกค้าขอใบราคา → โค้ดตอบเอง ไม่เรียก AI (ข้อความแจ้งว่าได้รับ/ส่งแล้ว ไม่นับ)
export function asksPriceList(text: string): boolean {
  const asks = /ใบราคา|ตารางราคา|เรทราคา|ราคาอั[ปพ]เด[ตท]|price ?list/i.test(text);
  return asks && !/แล้ว/.test(text);
}
