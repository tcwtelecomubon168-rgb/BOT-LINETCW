export type BotData = {
  updatedAt: string;
  faq: [string, string, string][]; // [หมวด, คำถาม, คำตอบ]
  price: [string, string, string, string][]; // [ยี่ห้อ, รุ่น, ราคาตัดสด, ราคาปลีก]
  branchStock: [string, string][]; // [สาขา, ชื่อสินค้า] เฉพาะที่มีของ
  warehouseStock: string[]; // ชื่อสินค้าที่ 3 คลังรวมกันมีของ
  warehouses?: Record<string, string[]>; // ชื่อสินค้าที่มีของ แยกตามพื้นที่ (Code.gs รุ่นใหม่)
  skus?: [string, string][]; // [SKU, ชื่อสินค้า] จากแท็บ "รหัสสินค้า" (ไม่บังคับ)
  problems: string[];
};

const TTL_MS = 60_000;
const TIMEOUT_MS = 6000;
let cache: { data: BotData; at: number } | null = null;

function valid(d: unknown): d is BotData {
  const x = d as BotData;
  return (
    !!x &&
    Array.isArray(x.faq) &&
    Array.isArray(x.price) &&
    Array.isArray(x.branchStock) &&
    Array.isArray(x.warehouseStock)
  );
}

export async function getBotData(): Promise<BotData | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = process.env.APPS_SCRIPT_URL;
    const key = process.env.APPS_SCRIPT_KEY;
    if (!url || !key) throw new Error("APPS_SCRIPT_URL / APPS_SCRIPT_KEY not set");

    const res = await fetch(`${url}?key=${encodeURIComponent(key)}`, {
      cache: "no-store",
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    if (json?.error === "forbidden") throw new Error("bad APPS_SCRIPT_KEY");
    if (!valid(json)) throw new Error("bad data shape");

    if (json.problems?.length) console.error("sheet problems:", JSON.stringify(json.problems));
    console.log(
      JSON.stringify({
        faq: json.faq.length,
        price: json.price.length,
        branchStock: json.branchStock.length,
        warehouseStock: json.warehouseStock.length,
        ms: Date.now() - started,
      }),
    );
    cache = { data: json, at: Date.now() };
    return json;
  } catch (e) {
    const ms = Date.now() - started;
    if (cache) {
      console.warn(`data fetch failed (${ms}ms), using stale cache:`, String(e));
      return cache.data;
    }
    console.error(`data fetch failed (${ms}ms), no cache:`, String(e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}
