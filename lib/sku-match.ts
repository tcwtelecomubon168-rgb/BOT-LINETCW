// เทียบ SKU บนฉลากกับตาราง "รหัสสินค้า" แล้วหาแถวในชีทราคา
// ตารางเก็บแบบ "001-SM-A077FLVDTHL-VL" | "SAMSUNG GALAXY A07s 4/64 LIGHT VIOLET"
import type { BotData } from "./data";
import { parseSpec, type BoxLabel } from "./image-match";

type PriceRow = BotData["price"][number];
export type SkuRow = [string, string]; // [รหัส, ชื่อสินค้า]

// Samsung: SM- + รุ่น + รหัสสี/ความจุ/ประเทศ (ต้องยาวกว่ารหัสรุ่นเฉย ๆ)
const SKU = /(?<![a-z0-9])sm-[a-z]\d{3}[a-z]{4,10}(?![a-z0-9])/i;

export const findSku = (...texts: (string | undefined)[]): string | undefined => {
  for (const t of texts) {
    const m = t?.match(SKU)?.[0];
    if (m) return m.toLowerCase();
  }
  return undefined;
};

// ชื่อสินค้าถึงแค่ความจุ (ส่วนหลังความจุคือสี)
const beforeColor = (name: string) =>
  name.match(/^.*?\d+\s*(?:gb|g)?\s*[+/]\s*\d+\s*(?:gb|tb|g(?![a-z]))?/i)?.[0];

function priceRowsFor(price: PriceRow[], name: string): PriceRow[] {
  // ร้านยืนยัน: รุ่น "5G T" และ Special Edition ราคาเท่ารุ่นปกติ
  // (คำว่า Special Edition อยู่หลังความจุ จึงถูกตัดไปพร้อมสี)
  const head = beforeColor(name.replace(/(\b5g)\s+t\b/i, "$1"));
  if (!head) return [];
  const brand = head.trim().split(/\s+/)[0].toLowerCase();
  const want = parseSpec(head);
  const found = price
    .map((row) => ({ row, spec: parseSpec(row[1]) }))
    .filter(
      ({ row, spec }) =>
        row[0].toLowerCase() === brand &&
        spec.key === want.key &&
        spec.ram === want.ram &&
        spec.storage === want.storage &&
        // 5G ต้องตรงกับแถว 5G · ไม่ระบุ = แถวที่ไม่ระบุหรือ LTE/4G
        (want.network === "5g" ? spec.network === "5g" : spec.network !== "5g"),
    );
  return found.map((f) => f.row);
}

// undefined = ไม่มี SKU ในตาราง (ให้ใช้วิธีเทียบอื่นต่อ) · row ว่าง = พบ SKU แต่ไม่แน่ใจ ให้ถามกลับ
export function matchSku(
  price: PriceRow[],
  skus: SkuRow[],
  sku: string | undefined,
  label: BoxLabel,
): { row?: PriceRow } | undefined {
  if (!sku) return undefined;
  const names = skus.filter(([code]) => findSku(code) === sku).map(([, name]) => name);
  if (!names.length) return undefined;

  const rows = Array.from(new Set(names.flatMap((n) => priceRowsFor(price, n))));
  if (rows.length !== 1) return {};
  // ความจุที่อ่านจากรูปต้องไม่ขัดกับแถวที่ได้
  const spec = parseSpec(rows[0][1]);
  const conflict =
    (!!label.storage_gb && !!spec.storage && label.storage_gb !== spec.storage) ||
    (!!label.ram_gb && !!spec.ram && label.ram_gb !== spec.ram);
  return conflict ? {} : { row: rows[0] };
}
