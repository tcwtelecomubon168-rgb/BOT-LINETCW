// ตัดของสาขากันทรลักษ์มี 2 โซน → ต้องถามโซนก่อน
import type { HistoryItem } from "./history";

export const ZONE_ASK_REPLY =
  "คุณลูกค้าต้องการตัดของสาขากันทรลักษ์ โซน Event หรือ ด้านใน คะ\nโซน Event กด 1\nด้านใน กด 2";

// ชื่อต้องตรงกับคอลัมน์ "คลัง" ในชีทสต๊อกสาขา (หลังตัด RT-)
export const ZONE_BRANCHES = {
  event: "Lotus กันทรลักษ์ Zone Event",
  inside: "Lotus กันทรลักษณ์",
} as const;
export type Zone = keyof typeof ZONE_BRANCHES;

const BRANCH = /กันทร?ลัก/; // ไม่ตรงกับ "กันทรารมย์"
// รวมกรณีพิมพ์ตก ต เช่น "ัดเครื่อง"
export const CUT = /ตัด(?!สด)|ัดเครื่อง|เบิกจากสาขา/;

function zoneWord(text: string): Zone | undefined {
  const event = /event|evnet|อีเว้น|อีเว็น|อีเวน/i.test(text);
  const inside = /ด้านใน|ข้างใน|โซนใน/.test(text);
  return event === inside ? undefined : event ? "event" : "inside";
}

// คำตอบของคำถามโซน: 1 / 2 / กด 1 / ชื่อโซน
export function zoneAnswer(text: string): Zone | undefined {
  const m = text.trim().match(/^(?:กด|เลข|ข้อ)?\s*([12๑๒])\s*(?:ค่ะ|คะ|ครับ|คับ|จ้า|นะคะ|นะครับ)?$/);
  if (m) return m[1] === "1" || m[1] === "๑" ? "event" : "inside";
  return zoneWord(text);
}

export function needsZoneAsk(text: string, history: HistoryItem[]): boolean {
  // ถามถึงทั้งสองโซน → ไม่ต้องให้เลือกโซน (ตรวจจากชีทว่าโซนไหนมี)
  if (!BRANCH.test(text) || zoneWord(text) || /ทั้ง\s*(2|สอง)/.test(text)) return false;
  return CUT.test(text) || history.some((h) => h.role === "user" && CUT.test(h.text));
}

// โซนที่ลูกค้าเลือกไว้ล่าสุด (ดูจากประวัติ + ข้อความปัจจุบัน)
export function chosenZone(text: string, history: HistoryItem[]): Zone | undefined {
  let zone: Zone | undefined;
  let lastAdmin = "";
  for (const h of [...history, { role: "user" as const, text }]) {
    if (h.role === "admin") {
      lastAdmin = h.text;
      continue;
    }
    const answer = lastAdmin === ZONE_ASK_REPLY ? zoneAnswer(h.text) : undefined;
    if (answer) zone = answer;
    else if (BRANCH.test(h.text)) zone = zoneWord(h.text);
  }
  return zone;
}
