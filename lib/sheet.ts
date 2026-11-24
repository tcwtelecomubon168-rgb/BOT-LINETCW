import Papa from "papaparse";
import { SHEET_CONFIG } from "./sheet-config";

type Row = Record<string, string>;
const TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 3000;
const MAX_CHARS = 60_000;
const cache = new Map<string, { data: Row[]; at: number }>();

function parseSources(): { name: string; url: string }[] {
  const raw = process.env.SHEET_CSV_URL || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf("|");
      return i === -1
        ? { name: "FAQ", url: s }
        : { name: s.slice(0, i).trim(), url: s.slice(i + 1).trim() };
    });
}

async function fetchSheet(name: string, url: string): Promise<Row[]> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const text = await res.text();
    const parsed = Papa.parse<Row>(text, { header: true, skipEmptyLines: true });
    const data = parsed.data.map((r) => {
      const o: Row = {};
      for (const k of Object.keys(r)) o[k.trim()] = (r[k] ?? "").toString().trim();
      return o;
    });
    cache.set(name, { data, at: Date.now() });
    return data;
  } catch (e) {
    if (hit) {
      console.warn(`sheet "${name}" fetch failed, using stale cache:`, String(e));
      return hit.data;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const toCsv = (header: string[], rows: string[][]) =>
  [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
const num = (v: string | undefined) => {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (s === "") return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

function convert(name: string, rows: Row[]): string | null {
  const cfg = SHEET_CONFIG[name];
  if (!cfg) return null;
  const c = cfg.columns;
  const has = (...cols: string[]) => rows.length > 0 && cols.every((k) => k in rows[0]);

  switch (cfg.kind) {
    case "faq": {
      if (!has(c.question, c.answer)) return null;
      const out = rows
        .filter((r) => (r[c.enabled] ?? "").toUpperCase() !== "N")
        .filter((r) => r[c.question] && r[c.answer])
        .map((r) => [r[c.category] ?? "", r[c.question], r[c.answer]]);
      return toCsv(["หมวดหมู่", "คำถาม", "คำตอบ"], out);
    }
    case "price": {
      if (!has(c.model, c.cash, c.retail)) {
        console.error("price columns missing");
        return null;
      }
      const out = rows
        .filter((r) => r[c.model] && !isNaN(num(r[c.cash])) && !isNaN(num(r[c.retail])))
        .map((r) => [r[c.model], r[c.cash], r[c.retail]]);
      return toCsv(["รุ่น", "ราคาตัดสด", "ราคาปลีก"], out);
    }
    case "branchStock": {
      if (!has(c.model, c.branch, c.qty)) {
        console.error(`stock columns missing in "${name}"`);
        return null;
      }
      const out = rows
        .filter((r) => r[c.model] && r[c.branch])
        .map((r) => [r[c.model], r[c.branch], (num(r[c.qty]) || 0) > 0 ? "มี" : "ไม่มี"]);
      return toCsv(["รุ่น", "สาขา", "สถานะ"], out);
    }
    default:
      return null;
  }
}

export async function getSheetsText(): Promise<string | null> {
  const sources = parseSources();
  const results = await Promise.allSettled(sources.map((s) => fetchSheet(s.name, s.url)));
  const data = new Map<string, Row[]>();
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") data.set(sources[i].name, r.value);
    else {
      failed.push(sources[i].name);
      console.warn(`sheet "${sources[i].name}" failed:`, String(r.reason));
    }
  });
  if (data.size === 0) {
    console.error("no sheet data available");
    return null;
  }

  const parts: string[] = [];
  const counts: Record<string, number> = {};
  const add = (name: string, body: string | null) => {
    if (body) parts.push(`<sheet name="${name}">\n${body}\n</sheet>`);
  };

  for (const [name, rows] of Array.from(data)) {
    counts[name] = rows.length;
    if (SHEET_CONFIG[name]?.kind === "warehouseStock") continue;
    add(name, convert(name, rows));
  }

  // รวมสต๊อกคลัง: ผลรวมต่อรุ่น → มี/ไม่มี (ไม่ส่งตัวเลข/ชื่อคลัง)
  const totals = new Map<string, number>();
  for (const [name, rows] of Array.from(data)) {
    const cfg = SHEET_CONFIG[name];
    if (cfg?.kind !== "warehouseStock") continue;
    const { model, qty } = cfg.columns;
    if (rows.length && !(model in rows[0] && qty in rows[0])) {
      console.error(`stock columns missing in "${name}"`);
      continue;
    }
    for (const r of rows) {
      if (!r[model]) continue;
      totals.set(r[model], (totals.get(r[model]) ?? 0) + (num(r[qty]) || 0));
    }
  }
  if (totals.size) {
    add(
      "สต๊อก",
      toCsv(
        ["รุ่น", "สถานะ"],
        Array.from(totals).map(([m, t]) => [m, t > 0 ? "มี" : "ไม่มี"]),
      ),
    );
  }

  if (parts.length === 0) {
    console.error("sheet data empty after conversion");
    return null;
  }
  const text = parts.join("\n");
  console.log(JSON.stringify({ sheets: counts, failed, chars: text.length }));
  if (text.length > MAX_CHARS) console.warn(`sheets text too large: ${text.length} chars`);
  return text;
}
