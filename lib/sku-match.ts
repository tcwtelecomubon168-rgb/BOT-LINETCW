// เทียบ SKU บนฉลากกับตาราง "รหัสสินค้า" แล้วหาแถวในชีทราคา
// ตารางเก็บแบบ "001-SM-A077FLVDTHL-VL" | "SAMSUNG GALAXY A07s 4/64 LIGHT VIOLET"
import type { BotData } from "./data";
import { brandOf, parseSpec, ramFits, type BoxLabel } from "./image-match";

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

// รูปแบบความจุ: Ram4 Rom64 · 4/64GB, 8+256G · 256GB 8GB · 128GB
const CAPACITY =
  /ram\s*\d+(?:\s*\+\s*\d+)?\s*rom\s*\d+\s*(?:gb|tb|g(?![a-z]))?|(\d+)\s*(?:gb|g)?\s*[+/]\s*(\d+)\s*(?:gb|tb|g(?![a-z]))?|\d+\s*(?:gb|tb)(?:\s+\d+\s*gb)?/gi;

// ชื่อสินค้าถึงแค่ความจุ (ส่วนหลังความจุคือสี)
function beforeColor(name: string): string | undefined {
  for (const m of Array.from(name.matchAll(CAPACITY))) {
    // "A11+ 5G" หน้าตาเหมือนคู่ความจุ แต่ไม่มีเลขความจุจริง (32 ขึ้นไป หรือหน่วย TB)
    if (m[1] && Math.max(Number(m[1]), Number(m[2])) < 32 && !/tb/i.test(m[0])) continue;
    return name.slice(0, (m.index ?? 0) + m[0].length);
  }
  return undefined;
}

function priceRowsFor(price: PriceRow[], name: string): PriceRow[] {
  // ร้านยืนยัน: Special Edition ราคาเท่ารุ่นปกติ (อยู่หลังความจุ จึงถูกตัดไปพร้อมสี)
  // รุ่นที่มีตัว T จัดการใน parseSpec
  const head = beforeColor(name);
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

export type SkuMatch = {
  row?: PriceRow;
  options?: PriceRow[]; // รุ่นเดียวแต่หลายความจุ ใช้ถามลูกค้า
  capacityUnread?: boolean;
  conflict?: boolean;
};

// รหัสที่บอกได้แค่รุ่น (เลขรุ่น Apple, TAC): ไม่ใช้ความจุที่เขียนในตาราง ต้องอ่านจากกล่อง
function matchModelOnly(price: PriceRow[], names: string[], label: BoxLabel): SkuMatch {
  const models = names.map((n) => {
    // ไม่มีความจุในชื่อ (ปุ่มกด) → ตัดสีที่อยู่หลังขนาดจอ เช่น G6 4G 2.4" BLACK
    const model = beforeColor(n) ?? n.match(/^.*?\d(?:\.\d+)?\s*(?:"|-?inch)/i)?.[0] ?? n;
    // บางชื่อเขียน (5G) ไว้หลังสี จึงดูจากชื่อเต็ม
    return { brand: brandOf(n), key: parseSpec(model).key, is5g: /(?<![a-z0-9])5g(?![a-z0-9])/i.test(n) };
  });
  // รหัสชี้ไปหลายรุ่น = ข้อมูลขัดกัน
  if (new Set(models.map((m) => `${m.key}|${m.is5g}`)).size !== 1 || !models[0].key) return {};
  const want = models[0];

  const siblings = price
    .map((row) => ({ row, spec: parseSpec(row[1]) }))
    .filter(
      ({ row, spec }) =>
        want.brand.startsWith(brandOf(row[0])) &&
        spec.key === want.key &&
        (spec.network === "5g") === want.is5g,
    );
  const found = siblings.filter(
    ({ spec }) =>
      (!label.storage_gb || !spec.storage || spec.storage === label.storage_gb) &&
      (!label.ram_gb || !spec.ram || ramFits(spec, label.ram_gb)),
  );
  if (found.length !== 1) return found.length ? { options: found.map((f) => f.row) } : {};
  const { row, spec } = found[0];
  // ยี่ห้อที่อ่านจากกล่องต้องไม่ขัดกับแถวที่ได้
  if (label.brand && brandOf(label.brand) !== brandOf(row[0])) return {};
  // อ่านความจุไม่ครบ: ตอบได้เพราะเหลือรายการเดียว แต่ให้ลูกค้าเช็ก
  const capacityUnread =
    (!!spec.storage && !label.storage_gb) || (!!spec.ram && !label.ram_gb);
  return { row, capacityUnread };
}

// รหัสโรงงานในแท็บ "รหัสสินค้า" เช่น CPH2819 หรือเลขรุ่น Apple A3354 (ใช้ร่วมกันทุกความจุและสี)
// ช่องรหัสมีคำอื่นปนได้ เช่น "iPad A3354"
const APPLE_CODE = /^a[123]\d{3}$/;

function matchFactoryCode(
  price: PriceRow[],
  skus: SkuRow[],
  label: BoxLabel,
): SkuMatch | undefined {
  const code = label.model_code?.toLowerCase();
  if (!code) return undefined;
  const names = skus
    .filter(
      ([cell, name]) =>
        cell.toLowerCase().split(/\s+/).includes(code) &&
        // เลขแบบ A3354 ใช้เฉพาะสินค้า Apple (กันชนกับรหัสยี่ห้ออื่น)
        (!APPLE_CODE.test(code) || /^\s*apple/i.test(name)),
    )
    .map(([, name]) => name);
  return names.length ? matchModelOnly(price, names, label) : undefined;
}

// แท็บ "รหัส IMEI": [TAC 8 หลัก, ชื่อสินค้า] · undefined = ไม่มี TAC ในตาราง
export function matchTac(
  price: PriceRow[],
  table: SkuRow[],
  label: BoxLabel,
): SkuMatch | undefined {
  const tacs = label.tacs ?? [];
  const names = table.filter(([tac]) => tacs.includes(tac.trim())).map(([, name]) => name);
  return names.length ? matchModelOnly(price, names, label) : undefined;
}

// undefined = ไม่มีรหัสในตาราง (ให้ใช้วิธีเทียบอื่นต่อ) · row ว่าง = พบรหัสแต่ไม่แน่ใจ ให้ถามกลับ
export function matchSku(
  price: PriceRow[],
  skus: SkuRow[],
  sku: string | undefined,
  label: BoxLabel,
): SkuMatch | undefined {
  if (!sku) return matchFactoryCode(price, skus, label);
  const names = skus.filter(([code]) => findSku(code) === sku).map(([, name]) => name);
  if (!names.length) return undefined;

  const rows = Array.from(new Set(names.flatMap((n) => priceRowsFor(price, n))));
  if (rows.length !== 1) return {};
  // ความจุที่อ่านจากรูปต้องไม่ขัดกับแถวที่ได้
  const spec = parseSpec(rows[0][1]);
  const conflict =
    (!!label.storage_gb && !!spec.storage && label.storage_gb !== spec.storage) ||
    (!!label.ram_gb && !!spec.ram && !ramFits(spec, label.ram_gb));
  return conflict ? { conflict: true } : { row: rows[0] };
}
