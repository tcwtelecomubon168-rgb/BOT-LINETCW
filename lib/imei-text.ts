// ลูกค้าพิมพ์เลข IMEI → โค้ดค้นราคาตัดสดเอง ไม่ส่งข้อความให้ AI
// ใช้แค่ 8 หลักแรก และห้ามบันทึกเลขเต็มลง log ประวัติแชท หรือชีท
import { CASH_PRICE_ASK_REPLY } from "./cash-price";
import type { BotData } from "./data";
import { tacsFrom } from "./imei";
import { parseSpec, ramFits } from "./image-match";
import { matchSerial, matchTac, type SkuMatch } from "./sku-match";

type PriceRow = BotData["price"][number];

export const IMEI_INVALID_REPLY = "เลข IMEI ไม่ถูกต้องค่ะ รบกวนคุณลูกค้าตรวจสอบเลขอีกครั้งนะคะ";

// คำที่พิมพ์ประกอบกับเลขได้ · มีข้อความอื่นปน (เช่น ข้อความแจ้งงาน) ไม่นับว่าเป็นการถามราคา
const FILLER =
  /imei\s*[12]?(?!\d)|อีมี่|อีมี|ตัดสด|หน้าร้าน|ราคา|เช็ค|เช็ก|ค่ะ|คะ|ครับ|คับ|ครัช|จ้า|จ้ะ|นะ|หน่อย|[:：=,.()#?]/gi;
const NUMBER = /\d(?:[ -]?\d){14}(?:\/\d{1,2}(?!\d))?/g;

// undefined = ไม่ใช่ข้อความส่ง IMEI · tacs ว่าง = เลขผิด · cashCut = มีคำว่า "ตัดสด"
export function parseImeiText(text: string): { tacs: string[]; cashCut: boolean } | undefined {
  const rest = text.replace(FILLER, " ");
  const numbers = rest.match(NUMBER);
  if (!numbers || numbers.length > 2 || rest.replace(NUMBER, "").trim()) return undefined;
  return { tacs: tacsFrom(numbers), cashCut: text.includes("ตัดสด") };
}

const priceLine = (row: PriceRow) => `${row[1]} ราคาตัดสด ${row[2]} บาท ค่ะ 😊`;

type CodeReply = { reply: string; row?: PriceRow; options?: PriceRow[] };

// เลขที่ลูกค้าพิมพ์มา: IMEI (เหลือ 8 หลักแรก) หรือ Serial
export type TypedCode = { tacs: string[] } | { serial: string };

function toReply(source: string, found: SkuMatch | undefined): CodeReply {
  if (found?.row) {
    return {
      row: found.row,
      reply: `จาก ${source}: ${priceLine(found.row)}
รบกวนเช็กรุ่นและความจุบนกล่อง หากไม่ตรง แจ้งได้เลยนะคะ`,
    };
  }
  if (found?.options && found.options.length <= 5) {
    return {
      options: found.options,
      reply: `จาก ${source} รุ่นนี้มีหลายความจุค่ะ คุณลูกค้าต้องการความจุไหนคะ
${found.options.map((r) => `- ${r[1]}`).join("\n")}`,
    };
  }
  return { reply: CASH_PRICE_ASK_REPLY };
}

export const codePriceReply = (data: BotData, code: TypedCode): CodeReply =>
  "serial" in code
    ? toReply("Serial", matchSerial(data.price, data.serials ?? [], code.serial))
    : toReply("IMEI", matchTac(data.price, data.tacs ?? [], { tacs: code.tacs }));

// ของที่รอข้อความถัดไป (Vercel เริ่มเครื่องใหม่แล้วหาย → ข้อความถัดไปเข้าขั้นตอนปกติ)
const WAIT_MS = 5 * 60_000;

// ส่งเลขมาก่อน ยังไม่พิมพ์ "ตัดสด" → จำไว้ในหน่วยความจำ 5 นาที (IMEI เหลือ 8 หลักแรก)
const waitingCodes = new Map<string, { code: TypedCode; at: number }>();

export function rememberCode(userId: string, code: TypedCode): void {
  for (const [k, v] of Array.from(waitingCodes)) if (Date.now() - v.at > WAIT_MS) waitingCodes.delete(k);
  waitingCodes.set(userId, { code, at: Date.now() });
}

// ดึงแล้วลบ → ใช้ครั้งเดียว
export function takeCode(userId: string): TypedCode | undefined {
  const w = waitingCodes.get(userId);
  waitingCodes.delete(userId);
  return w && Date.now() - w.at <= WAIT_MS ? w.code : undefined;
}

// ตัวเลือกความจุที่ถามไว้
const pending = new Map<string, { rows: PriceRow[]; at: number }>();

export function setCapacityOptions(userId: string, rows: PriceRow[]): void {
  for (const [k, v] of Array.from(pending)) if (Date.now() - v.at > WAIT_MS) pending.delete(k);
  pending.set(userId, { rows, at: Date.now() });
}

// ลูกค้าตอบเฉพาะความจุ เช่น "4/64", "128", "ความจุ 256GB ค่ะ" → คืนแถวที่ตรงรายการเดียว
export function pickCapacity(text: string, rows: PriceRow[]): PriceRow | undefined {
  const rest = text
    .toLowerCase()
    .replace(/ความจุ|เอา|รุ่น|ตัว|ตัดสด|ราคา|ค่ะ|คะ|ครับ|คับ|จ้า|นะ|ram|rom|แรม|รอม/g, " ")
    .trim();
  const m = rest.match(/^(?:(\d+)\s*(?:gb|g)?\s*[+/]\s*)?(\d+)\s*(gb|g|tb)?$/);
  if (!m) return undefined;
  const ram = m[1] ? Number(m[1]) : undefined;
  const storage = Number(m[2]) * (m[3] === "tb" ? 1024 : 1);
  const found = rows.filter((row) => {
    const spec = parseSpec(row[1]);
    return spec.storage === storage && (!ram || ramFits(spec, ram));
  });
  return found.length === 1 ? found[0] : undefined;
}

// ใช้ได้กับข้อความถัดไปข้อความเดียว
export function takeCapacityAnswer(userId: string, text: string): PriceRow | undefined {
  const p = pending.get(userId);
  pending.delete(userId);
  return p && Date.now() - p.at <= WAIT_MS ? pickCapacity(text, p.rows) : undefined;
}

export const capacityPriceReply = priceLine;
