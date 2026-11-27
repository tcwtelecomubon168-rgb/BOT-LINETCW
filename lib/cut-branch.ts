// ตัดของสาขา: AI มีหน้าที่แค่ระบุสินค้า · "สาขาไหนมีของ" โค้ดตรวจจากชีทและเขียนคำตอบเอง
import { CUT_BRANCH_REPLY } from "./constants";
import type { GeminiResult } from "./gemini";
import type { HistoryItem } from "./history";
import { CUT, ZONE_ASK_REPLY, ZONE_BRANCHES, zoneAnswer, chosenZone } from "./kantharalak";

type Row = [string, string]; // [สาขา, ชื่อสินค้า]

const MAX_LIST = 5;
const ONLY_ONE_ASK = "คุณลูกค้าต้องการตัดจากสาขานี้ไหมคะ";
export const SPEC_ASK_REPLY = "รบกวนคุณลูกค้าแจ้งรุ่น ความจุ และสีที่ต้องการตัดอีกครั้งนะคะ";

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9ก-๙+]/g, "");
// ตัดการันต์ (ลักษ์ / ลักษณ์ ให้เท่ากัน) และช่องว่าง
const normThai = (s: string) => s.toLowerCase().replace(/ณ?์/g, "").replace(/\s+/g, "");

const CHAINS: [RegExp, RegExp][] = [
  [/bigc|บิ๊กซี|บิกซี/, /bigc/i],
  [/lotus|โลตัส/, /lotus/i],
  [/central|เซ็นทรัล|เซนทรัล/, /central/i],
];

// สาขาที่ข้อความเอ่ยถึง (ชื่อพื้นที่ ± ชื่อห้าง)
export function mentionedBranches(text: string, branches: string[]): string[] {
  const t = normThai(text);
  const chains = CHAINS.filter(([inText]) => inText.test(t)).map(([, inName]) => inName);
  const inChain = (b: string) => !chains.length || chains.some((re) => re.test(b));

  let found = branches.filter((b) => {
    const place = normThai(b.replace(/สาขา/g, "")).match(/[ก-๙]+/)?.[0];
    return !!place && t.includes(place.slice(0, 6)) && inChain(b);
  });
  // บอกแค่ชื่อห้าง เช่น Central
  if (!found.length && /central|เซ็นทรัล|เซนทรัล/.test(t)) {
    found = branches.filter((b) => /central/i.test(b));
  }
  for (const word of ["kiosk", "shop"]) {
    const narrowed = found.filter((b) => b.toLowerCase().includes(word));
    if (t.includes(word) && narrowed.length) found = narrowed;
  }
  return found;
}

// สาขาที่ลูกค้าระบุสำหรับคำขอนี้ · ย้อนดูได้ไม่เกินข้อความที่เริ่มคำขอตัดของ
function namedByCustomer(text: string, history: HistoryItem[], branches: string[]): string[] {
  if (/สาขาไหน|สาขาอะไร|สาขาใด|ที่ไหน/.test(text)) return [];
  const all: HistoryItem[] = [...history, { role: "user", text }];
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].role !== "user") continue;
    const msg = all[i].text;
    const prevAdmin = all.slice(0, i).reverse().find((h) => h.role === "admin")?.text;
    const answer = prevAdmin === ZONE_ASK_REPLY ? zoneAnswer(msg) : undefined;
    if (answer) return [ZONE_BRANCHES[answer]];
    let found = mentionedBranches(msg, branches);
    if (found.length) {
      const zone = chosenZone(text, history);
      const other = zone && ZONE_BRANCHES[zone === "event" ? "inside" : "event"];
      if (other) found = found.filter((b) => b !== other);
      return found;
    }
    if (CUT.test(msg)) break;
  }
  return [];
}

function list(branches: string[]) {
  const shown = branches.slice(0, MAX_LIST).join(", ");
  return branches.length > MAX_LIST ? `${shown} และสาขาอื่นอีก` : shown;
}

// ลูกค้าตอบรับหลังบอทเสนอสาขาเดียว (AI อาจมองว่าเป็นแค่การตอบรับแล้วเงียบ จึงตรวจเอง)
function acceptedOffer(text: string, history: HistoryItem[], rows: Row[]) {
  const lastAdmin = [...history].reverse().find((h) => h.role === "admin")?.text ?? "";
  if (!lastAdmin.includes(ONLY_ONE_ASK) || /ไม่/.test(text)) return undefined;
  if (!/^s*(ใช่|ได้|เอา|ตกลง|โอเค|ok)/i.test(text)) return undefined;
  const found = rows.find(
    ([branch, product]) =>
      lastAdmin.startsWith(`${product} จากสาขา`) &&
      lastAdmin.includes(`เฉพาะสาขา ${branch} ค่ะ`),
  );
  return found && { branch: found[0], product: found[1] };
}

export function verifyCutBranch(
  r: GeminiResult,
  text: string,
  history: HistoryItem[],
  rows: Row[],
): GeminiResult {
  const accepted = r.errorReason ? undefined : acceptedOffer(text, history, rows);
  if (accepted) {
    return { ...r, ...accepted, intent: "cut_branch", reply: CUT_BRANCH_REPLY, inStock: true };
  }

  const cutTalk = CUT.test(text) || history.some((h) => h.role === "user" && CUT.test(h.text));
  const talksBranch = /สาขา|lotus|bigc|central/i.test(r.reply);
  const relevant =
    r.intent === "cut_branch" ||
    (cutTalk && talksBranch && (r.intent === "product_ask" || r.intent === "stock"));
  if (!relevant) return r;

  // หาชื่อสินค้าที่ตรงทั้งชื่อ (รวมสี) · ถ้า AI ไม่ใส่ product ให้หาจากคำตอบ
  const names = Array.from(new Set(rows.map((x) => x[1])));
  let product = names.find((n) => normName(n) === normName(r.product ?? ""));
  if (!product) {
    const inReply = names.filter((n) => normName(r.reply).includes(normName(n)));
    if (inReply.length === 1) product = inReply[0];
  }

  if (!product) {
    // ตรวจไม่ได้ → ห้ามปล่อยคำตอบที่อ้างชื่อสาขา หรือยืนยันว่ามีของ
    if (!talksBranch && r.inStock !== true) return r;
    console.warn(JSON.stringify({ note: "cut_branch unverified", product: r.product }));
    return { ...r, intent: "product_ask", reply: SPEC_ASK_REPLY, inStock: undefined, branch: undefined };
  }

  const have = Array.from(new Set(rows.filter((x) => x[1] === product).map((x) => x[0])));
  const allBranches = Array.from(new Set(rows.map((x) => x[0])));
  const base = { ...r, intent: "cut_branch", product, inStock: undefined, branch: undefined };
  const confirm = (branch: string) => ({ ...base, reply: CUT_BRANCH_REPLY, inStock: true, branch });

  const named = namedByCustomer(text, history, allBranches);
  if (!named.length) {
    return { ...base, reply: `${product} มีที่สาขา ${list(have)} ค่ะ\nคุณลูกค้าต้องการตัดจากสาขาไหนคะ` };
  }
  const match = named.filter((b) => have.includes(b));
  if (!match.length) {
    return {
      ...base,
      reply: `สาขา ${list(named)} ตอนนี้ไม่มี ${product} ค่ะ\nมีที่สาขา ${list(have)} คุณลูกค้าต้องการตัดจากสาขาไหนคะ`,
      inStock: false,
      branch: named[0],
    };
  }
  if (named.length === 1) return confirm(match[0]);
  if (match.length === 1) {
    return {
      ...base,
      reply: `${product} จากสาขาที่คุณลูกค้าแจ้ง มีเฉพาะสาขา ${match[0]} ค่ะ\n${ONLY_ONE_ASK}`,
    };
  }
  return { ...base, reply: `${product} มีที่สาขา ${list(match)} ค่ะ\nคุณลูกค้าต้องการตัดจากสาขาไหนคะ` };
}
