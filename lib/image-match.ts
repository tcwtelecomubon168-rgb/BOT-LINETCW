// เทียบข้อมูลที่อ่านจากฉลากกล่อง กับชีทราคา แบบเข้มงวด · ไม่แน่ใจ = ไม่ตอบราคา
import type { BotData } from "./data";

export interface BoxLabel {
  brand?: string;
  model?: string;
  model_code?: string;
  sku?: string;
  ram_gb?: number;
  storage_gb?: number;
  network?: string;
}

type PriceRow = BotData["price"][number];
type Spec = { key: string; ram?: number; storage?: number; network?: "5g" | "4g" };

// คำที่ไม่ใช้แยกรุ่น (ยี่ห้อตรวจแยกต่างหาก)
const IGNORE =
  /apple|samsung|galaxy|oppo|vivo|realme|honor|xiaomi|redmi|infinix|tecno|zte|nubia|benco|nokia|tcl|new product|dualsim|wi-?fi/g;

const brandOf = (s: string) => {
  const t = s.toLowerCase().replace(/\s+/g, "");
  if (/apple|iphone|ipad/.test(t)) return "apple";
  if (/xiaomi|redmi|poco/.test(t)) return "xiaomi";
  return t;
};

const isStorage = (n: number) => n >= 32;
const toGb = (n: string, unit?: string) => Number(n) * (unit === "tb" ? 1024 : 1);

export function parseSpec(name: string): Spec {
  let t = name
    .toLowerCase()
    .replace(/\d+(\.\d+)?\s*(-?\s*inch|")/g, " ") // ขนาดจอ
    .replace(/\(\s*(\d\.\d|20\d\d)\s*\)/g, " "); // (2.8) (2024)

  let ram: number | undefined;
  let storage: number | undefined;
  const take = (re: RegExp, read: (m: RegExpMatchArray) => boolean) => {
    if (storage !== undefined) return;
    const m = t.match(re);
    if (m && read(m)) t = t.replace(m[0], " ");
  };
  const pair = (a: number, b: number) => {
    const big = Math.max(a, b);
    const small = Math.min(a, b);
    if (!isStorage(big) || small > 24) return false;
    ram = small;
    storage = big;
    return true;
  };

  // Ram4 Rom128 · Ram2+4 Rom 64GB
  take(/ram\s*(\d+)(?:\s*\+\s*\d+)?\s*rom\s*(\d+)\s*(?:gb|g|tb)?/, (m) => {
    ram = Number(m[1]);
    storage = Number(m[2]);
    return true;
  });
  // 8/256 · 8+256 · 256+12 · (6GB+128GB) · (8+128G)
  // ไล่ทุกตำแหน่ง: ชื่ออย่าง "A11+ 5G (6/128)" มี "11+ 5G" มาก่อนความจุจริง
  const pairs = /(?:ram\s*)?(\d+)\s*(?:gb|g)?\s*[+/]\s*(\d+)\s*(gb|g|tb)?(?![a-z0-9])/g;
  for (const m of Array.from(t.matchAll(pairs))) {
    if (storage === undefined && pair(Number(m[1]), toGb(m[2], m[3]))) t = t.replace(m[0], " ");
  }
  // 512GB 12GB · 64GB 4GB
  take(/(\d+)\s*(gb|tb)\s+(\d+)\s*(gb|tb)/, (m) => pair(toGb(m[1], m[2]), toGb(m[3], m[4])));
  // 256GB
  take(/(\d+)\s*(gb|tb)/, (m) => {
    const n = toGb(m[1], m[2]);
    if (!isStorage(n)) return false;
    storage = n;
    return true;
  });

  let network: Spec["network"];
  if (/(?<![a-z0-9])5g(?![a-z0-9])/.test(t)) network = "5g";
  else if (/(?<![a-z0-9])(4g|lte)(?![a-z0-9])/.test(t)) network = "4g";

  // รหัสรุ่นท้ายชื่อ · x + เลข 3 ตัว ตัดเฉพาะแท็บเล็ต (X200 ของรุ่นอื่นคือชื่อรุ่น)
  if (/(?<![a-z])tab(?![a-z])/.test(t)) t = t.replace(/(?<![a-z0-9])x\d{3}(?![a-z0-9])/g, " ");
  t = t.replace(/(?<![a-z0-9])(x\d{4}[a-z]?|rmx\d{4}|cph\d{4}|sm-[a-z]\d{3}[a-z]*)(?![a-z0-9])/g, " ");

  const key = t
    .replace(IGNORE, " ")
    .replace(/(?<![a-z0-9])(5g|4g|3g|lte)(?![a-z0-9])/g, " ")
    .replace(/[^a-z0-9+]/g, "");

  return { key, ram, storage, network };
}

export type BoxMatch = {
  row: PriceRow;
  capacityUnread: boolean; // true = อ่านความจุจากรูปได้ไม่ครบ แต่ชีทมีรุ่นนี้รายการเดียว
};

// รหัสรุ่นโรงงาน เช่น X6725, RMX3933, SM-A075F (ตัวเลขล้วนอย่าง IMEI ไม่ผ่าน)
const MODEL_CODE = /^(?=.*[a-z])[a-z]{0,3}-?[a-z]?\d{3,5}[a-z0-9]{0,4}$/i;
// Samsung: SM-A077F/DS หรือรหัสยาว SM-A077FLVDTHL (ต่อท้ายด้วยสี/ประเทศ) → SM-A077F
const SAMSUNG_CODE = /(?<![a-z0-9])sm-[a-z]\d{3}[a-z]?/i;
export function validModelCode(code?: string): string | undefined {
  const raw = code?.trim() ?? "";
  const samsung = raw.match(SAMSUNG_CODE)?.[0];
  const c = samsung ?? raw.split("/")[0];
  return MODEL_CODE.test(c) && !/\d{8,}/.test(c) ? c.toLowerCase() : undefined;
}

// ในชีทเขียนได้ทั้ง SM-A077F, SM-A077F/DS หรือ A077F (แบบเดียวกับ X520 ที่มีอยู่)
const codeForms = (code: string) =>
  code.startsWith("sm-") ? [code, code.slice(3)] : [code];
const hasCode = (name: string, code: string) =>
  codeForms(code).some((c) => new RegExp(`(?<![a-z0-9-])${c}(?![a-z0-9-])`, "i").test(name));
const without = (name: string, code: string) =>
  codeForms(code).reduce((t, c) => t.split(c).join(" "), name.toLowerCase()).replace(/\/ds\b/g, " ");

// ชื่อรุ่นในชีทมีรหัสรุ่นกำกับอยู่แล้วหรือไม่
const TAGGED = /(?<![a-z0-9])(sm-[a-z]\d{3}[a-z]?|[a-z]\d{3}[a-z]|x\d{3,4}[a-z]?|rmx\d{4}|cph\d{4})(?![a-z0-9])/i;

// คืนผลเมื่อ "ตรงรายการเดียว" เท่านั้น
export function matchBoxLabel(price: PriceRow[], label: BoxLabel): BoxMatch | undefined {
  // รหัสอาจถูกใส่มาในช่องชื่อรุ่น
  const inModel = label.model?.match(SAMSUNG_CODE)?.[0];
  const code = validModelCode(label.model_code) ?? validModelCode(inModel);
  // ฉลากบางด้านไม่มีคำว่า Samsung แต่รหัส SM- บอกยี่ห้อได้
  const brandText = label.brand || (code?.startsWith("sm-") ? "samsung" : "");
  if (!brandText) return undefined;
  const brand = brandOf(brandText);
  const rows = price.filter((row) => brandOf(row[0]) === brand);
  const byCode = code ? rows.filter((row) => hasCode(row[1], code)) : [];

  const modelText = (label.model ?? "").replace(new RegExp(`${SAMSUNG_CODE.source}\\S*`, "gi"), " ");
  const want = parseSpec(code ? without(modelText, code) : modelText);
  // ไม่พบรหัสในชีท → เทียบด้วยชื่อรุ่น
  if (!byCode.length && !want.key) return undefined;
  const ram = label.ram_gb || want.ram;
  const storage = label.storage_gb || want.storage;
  const net = parseSpec(`x ${label.network ?? ""}`).network ?? want.network;

  const all = rows.map((row) => ({
    row,
    spec: parseSpec(code ? without(row[1], code) : row[1]),
  }));
  // พบรหัสในชีท: ถ้าอ่านชื่อรุ่นได้ด้วย ต้องไม่ขัดกัน
  const sameModel = byCode.length
    ? all.filter((c) => byCode.includes(c.row) && (!want.key || c.spec.key === want.key))
    : // เทียบด้วยชื่อ: อ่านรหัสได้แต่แถวนั้นมีรหัสอื่นกำกับ = คนละเครื่อง
      all.filter((c) => c.spec.key === want.key && !(code && TAGGED.test(c.row[1])));

  // รุ่นที่ในชีทระบุความจุ ต้องอ่านความจุ (และ RAM ถ้าชีทระบุ) จากรูปได้ตรงกัน
  let found = sameModel.filter(
    (c) =>
      c.spec.storage === undefined ||
      (c.spec.storage === storage && (c.spec.ram === undefined || c.spec.ram === ram)),
  );

  // ชีทมีรุ่นนี้รายการเดียว และค่าที่อ่านได้ไม่ขัดกัน (แค่อ่านไม่ครบ)
  let capacityUnread = false;
  if (!found.length && sameModel.length === 1) {
    const { spec } = sameModel[0];
    const missing = !storage || (spec.ram !== undefined && !ram);
    const conflict = (!!storage && storage !== spec.storage) ||
      (!!ram && spec.ram !== undefined && ram !== spec.ram);
    // รุ่นเดียวกันมีแถวอื่นที่ยังไม่ได้ใส่รหัส → ความจุไม่แน่ ให้ถามกลับ
    const untagged = byCode.length > 0 && all.filter((c) => c.spec.key === spec.key).length > 1;
    if (missing && !conflict && !untagged) {
      found = sameModel;
      capacityUnread = true;
    }
  }

  // 4G/5G ขัดกันตัดออก · เหลือหลายรายการเลือกตัวที่ระบุตรง
  if (net) {
    found = found.filter((c) => !c.spec.network || c.spec.network === net);
    const exact = found.filter((c) => c.spec.network === net);
    if (exact.length) found = exact;
    else if (found.length > 1) return undefined;
  }

  return found.length === 1 ? { row: found[0].row, capacityUnread } : undefined;
}
