// ถามราคาโดยระบุรุ่นชัด → โค้ดค้นและเขียนคำตอบจากชีทเอง ไม่ให้ AI เลือกแถวหรือพิมพ์ตัวเลข
// มีคำที่โค้ดไม่รู้จักปน หรือหารุ่นไม่เจอ → คืน undefined (เข้าขั้นตอน AI ตามเดิม)
import { CASH_PRICE_ASK_REPLY } from "./cash-price";
import type { BotData } from "./data";
import type { HistoryItem } from "./history";
import { brandOf, parseSpec, ramFits } from "./image-match";

type PriceRow = BotData["price"][number];
const MAX_ROWS = 5;

const ASKS_PRICE = /ราคา|ตัดสด|เท่าไหร่|เท่าไร|กี่บาท|price/i;
// คำประกอบคำถามราคา (เรียงคำยาวก่อน) · คำนอกรายการนี้ = อาจเป็นเรื่องอื่น
const FILLER =
  /สวัสดี|สอบถาม|รบกวน|ต้องการ|อยากทราบ|อยากรู้|ทราบ|หน้าร้าน|เงินสด|ซื้อสด|ราคา|ตัดสด|ปลีก|เท่าไหร่|เท่าไร|กี่บาท|บาท|หน่อย|ด้วย|เครื่อง|รุ่น|ความจุ|ของ|ตัว|ขอ|เช็ค|เช็ก|ถาม|แอดมิน|แอด|ครับผม|ครับ|คับ|ค่ะ|คะ|ค่า|จ้า|จ้ะ|นะ|อยู่|ละ|ล่ะ|และปลีก|price/gi;
const COLOR =
  /สี?(?:ดำ|ขาว|ฟ้า|น้ำเงิน|ม่วง|เขียว|ชมพู|ทอง|เงิน|เทา|ส้ม|แดง|เหลือง|ครีม|น้ำตาล)/g;
const BRAND =
  /apple|iphone|ipad|samsung|oppo|vivo|realme|honor|xiaomi|redmi|infinix|tecno|zte|benco|nokia|tcl|wiko/i;

const brandMatches = (said: string, rowBrand: string) =>
  brandOf(said) === brandOf(rowBrand) || (said === "nubia" && brandOf(rowBrand) === "zte");

export function findAskedRows(price: PriceRow[], text: string): PriceRow[] | undefined {
  const cleaned = text
    .replace(/แรม/g, " ram ")
    .replace(/รอม/g, " rom ")
    .replace(COLOR, " ")
    .replace(FILLER, " ")
    .replace(/[?!.,:]+(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /[ก-๙]/.test(cleaned)) return undefined;

  let want = parseSpec(cleaned);
  // "iphone 17 256" ไม่มีหน่วย → เลขความจุท้ายข้อความ
  if (!want.storage) {
    const m = cleaned.match(/^(.*\S)\s+(64|128|256|512)$/);
    if (m) want = { ...parseSpec(m[1]), storage: Number(m[2]) };
  }
  if (!want.key || !/[a-z]|\d{2}/.test(want.key)) return undefined;

  const said = cleaned.match(BRAND)?.[0].toLowerCase();
  let found = price
    .map((row) => ({ row, spec: parseSpec(row[1]) }))
    .filter(
      ({ row, spec }) =>
        spec.key === want.key &&
        (!said || brandMatches(said, row[0])) &&
        (!want.storage || spec.storage === want.storage) &&
        (!want.ram || !spec.ram || ramFits(spec, want.ram)),
    );
  // บอก 5G = เฉพาะ 5G · บอก 4G/LTE = ตัด 5G ออก · ไม่บอก = ตอบทุกแบบ
  if (want.network === "5g") found = found.filter((f) => f.spec.network === "5g");
  if (want.network === "4g") found = found.filter((f) => f.spec.network !== "5g");
  // บอก Wi-Fi = ไม่เอารุ่นใส่ซิม
  if (/wi-?fi/i.test(cleaned) && !want.network) found = found.filter((f) => !f.spec.network);

  const rows = found.map((f) => f.row);
  // ชื่อเดียวกันหลายยี่ห้อ หรือเยอะเกิน → ให้ขั้นตอนเดิมถามกลับ
  if (!rows.length || rows.length > MAX_ROWS) return undefined;
  return new Set(rows.map((r) => r[0])).size === 1 ? rows : undefined;
}

// ชื่อในชีทบางแถวไม่มียี่ห้อ เช่น "Note80 Ram4 Rom64"
function fullName(row: PriceRow): string {
  const known = BRAND.test(row[1]) || /galaxy|nubia|adapter|in link/i.test(row[1]);
  return known ? row[1] : `${row[0]} ${row[1]}`;
}

export function priceAnswer(
  price: PriceRow[],
  text: string,
  history: HistoryItem[],
): string | undefined {
  const lastAdmin = [...history].reverse().find((h) => h.role === "admin");
  // ตอบชื่อรุ่นหลังบอทถามว่าจะตัดสดรุ่นไหน
  const replyingCash = lastAdmin?.text === CASH_PRICE_ASK_REPLY;
  if (!ASKS_PRICE.test(text) && !replyingCash) return undefined;

  const rows = findAskedRows(price, text);
  if (!rows) return undefined;
  const wantsRetail = /ปลีก/.test(text);
  const cashOnly = (text.includes("ตัดสด") || replyingCash) && !wantsRetail;
  const lines = rows.map(
    (row) =>
      `${fullName(row)} ราคาตัดสด ${row[2]} บาท${cashOnly ? "" : ` ราคาปลีก ${row[3]} บาท`}`,
  );
  return `${lines.join("\n")} ค่ะ 😊`;
}
