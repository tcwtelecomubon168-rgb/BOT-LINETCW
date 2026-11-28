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

// ทุกแถวของ TAC นี้ในตารางระบุความจุตรงกัน → ใช้ความจุนั้น (ต่างกันหรือไม่ระบุ = ไม่เดา)
function tableCapacity(table: [string, string][], tacs: string[]) {
  const specs = table.filter(([tac]) => tacs.includes(tac)).map(([, name]) => parseSpec(name));
  const same = new Set(specs.map((s) => `${s.ram}|${s.storage}`)).size === 1;
  return same && specs[0].storage ? { ram_gb: specs[0].ram, storage_gb: specs[0].storage } : {};
}

export const codePriceReply = (data: BotData, code: TypedCode): CodeReply => {
  if ("serial" in code) {
    return toReply("Serial", matchSerial(data.price, data.serials ?? [], code.serial));
  }
  const table = data.tacs ?? [];
  const label = { tacs: code.tacs, ...tableCapacity(table, code.tacs) };
  return toReply("IMEI", matchTac(data.price, table, label));
};

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

// ข้อความที่มีแต่ความจุ เช่น "4/64", "อีมี่ 128", "ความจุ 256GB ค่ะ" · ไม่ใช่ = undefined
function readCapacity(text: string): { ram?: number; storage: number } | undefined {
  const rest = text
    .toLowerCase()
    .replace(/ความจุ|เอา|รุ่น|ตัวสี|ตัว|ตัดสด|ราคา|imei|อีมี่|อีมี|ค่ะ|คะ|ครับ|คับ|จ้า|นะ|ram|rom|แรม|รอม/g, " ")
    .trim();
  const m = rest.match(/^(?:(\d+)\s*(?:gb|g)?\s*[+/]\s*)?(\d+)\s*(gb|g|tb)?$/);
  if (!m) return undefined;
  return {
    ram: m[1] ? Number(m[1]) : undefined,
    storage: Number(m[2]) * (m[3] === "tb" ? 1024 : 1),
  };
}

// คืนแถวที่ตรงรายการเดียว
export function pickCapacity(text: string, rows: PriceRow[]): PriceRow | undefined {
  const want = readCapacity(text);
  if (!want) return undefined;
  const found = rows.filter((row) => {
    const spec = parseSpec(row[1]);
    return spec.storage === want.storage && (!want.ram || ramFits(spec, want.ram));
  });
  return found.length === 1 ? found[0] : undefined;
}

// คำตอบหลังถามความจุ: ตรงตัวเลือก = แจ้งราคา · เป็นความจุแต่ไม่ตรง = ถามซ้ำ (ไม่ให้ AI เดารุ่น)
// undefined = เป็นข้อความเรื่องอื่น ให้เข้าขั้นตอนปกติ
export function takeCapacityAnswer(
  userId: string,
  text: string,
): { reply: string; row?: PriceRow } | undefined {
  const p = pending.get(userId);
  if (!p) return undefined;
  const row = pickCapacity(text, p.rows);
  const valid = Date.now() - p.at <= WAIT_MS;
  if (valid && !row && readCapacity(text)) {
    return {
      reply: `รบกวนเลือกความจุจากรายการนี้นะคะ
${p.rows.map((r) => `- ${r[1]}`).join("\n")}`,
    };
  }
  pending.delete(userId); // เลือกได้แล้ว หรือคุยเรื่องอื่น
  return valid && row ? { row, reply: priceLine(row) } : undefined;
}
