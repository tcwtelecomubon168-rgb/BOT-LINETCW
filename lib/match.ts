// คัดสินค้าที่ตรงกับคำถามลูกค้า (ชื่อในชีทเป็นอังกฤษ ลูกค้าพิมพ์ไทย/อังกฤษปนกัน)

// คำไทยที่ลูกค้าใช้บ่อย → token อังกฤษที่ใช้ในชื่อสินค้า (เรียงยาวไปสั้นตอนค้น)
const ALIASES: Record<string, string[]> = {
  ไอโฟน: ["iphone"],
  ไอโฟล: ["iphone"],
  ไอแพด: ["ipad"],
  แอปเปิ้ล: ["apple"],
  แอปเปิล: ["apple"],
  โปรแม็กซ์: ["pro", "max"],
  โปรแมกซ์: ["pro", "max"],
  โปรแม็ก: ["pro", "max"],
  โปรแมก: ["pro", "max"],
  โปร: ["pro"],
  แม็กซ์: ["max"],
  แมกซ์: ["max"],
  พลัส: ["plus"],
  อัลตร้า: ["ultra"],
  ไลท์: ["lite"],
  ไลต์: ["lite"],
  มินิ: ["mini"],
  แอร์: ["air"],
  วอทช์: ["watch"],
  วอช: ["watch"],
  นาฬิกา: ["watch"],
  ซัมซุง: ["samsung"],
  ซัมซุ่ง: ["samsung"],
  กาแลคซี่: ["galaxy"],
  กาแลกซี่: ["galaxy"],
  ออปโป้: ["oppo"],
  ออปโป: ["oppo"],
  เรโน: ["reno"],
  วีโว่: ["vivo"],
  วีโว: ["vivo"],
  เรียลมี: ["realme"],
  ฮอนเนอร์: ["honor"],
  ออเนอร์: ["honor"],
  เทคโน: ["tecno"],
  อินฟินิกซ์: ["infinix"],
  เสี่ยวหมี่: ["xiaomi"],
  เสียวหมี่: ["xiaomi"],
  เรดมี่: ["redmi"],
  โพโค: ["poco"],
  หัวเว่ย: ["huawei"],
  โน้ต: ["note"],
  ฟลิป: ["flip"],
  โฟลด์: ["fold"],
};

const ALIAS_KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length);
const STOP = new Set(["gb", "tb", "ram", "rom", "the", "and", "for"]);

// token = คำอังกฤษ/ตัวเลขจากข้อความ + คำที่แปลจากคำไทยตามตาราง ALIASES
// (ตัวเลข/ตัวอักษรติดกันถูกแยก เช่น 256gb → 256 + gb, iphone17 → iphone + 17)
export function queryTokens(text: string): string[] {
  let t = text.toLowerCase().replace(/โปรโมชั่น|โปรโมชัน|โปรโมชั่น/g, " ");
  const found: string[] = [];
  for (const k of ALIAS_KEYS) {
    if (t.includes(k)) {
      found.push(...ALIASES[k]);
      t = t.split(k).join(" ");
    }
  }
  const ascii = t.match(/[a-z]+|\d+/g) ?? [];
  const out = new Set<string>();
  for (const w of [...ascii, ...found]) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.add(w);
  }
  return Array.from(out);
}

// เลือกแถวที่ชื่อมี token ตรงมากที่สุด (เรียงตามคะแนน) ไม่เกิน limit แถว
export function pickRows<T>(
  rows: T[],
  nameOf: (row: T) => string,
  tokens: string[],
  limit: number,
): T[] {
  if (!tokens.length) return [];
  const scored: { row: T; score: number; i: number }[] = [];
  rows.forEach((row, i) => {
    const name = nameOf(row).toLowerCase();
    let score = 0;
    for (const tk of tokens) if (name.includes(tk)) score++;
    if (score > 0) scored.push({ row, score, i });
  });
  if (!scored.length) return [];
  const top = Math.max(...scored.map((s) => s.score));
  // ถามหลาย token แต่ตรงแค่ 1 token (เช่น "iphone 99") = ไม่มีรุ่นนั้นจริง ไม่ส่งรุ่นอื่นที่ไม่เกี่ยว
  if (tokens.length >= 2 && top < 2) return [];
  const min = top >= 2 ? top : 1;
  return scored
    .filter((s) => s.score >= min)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((s) => s.row);
}
