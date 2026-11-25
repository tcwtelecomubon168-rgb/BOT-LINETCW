/**
 * Code.gs — Apps Script ผูกกับไฟล์ Google Sheet "ข้อมูลบอท" (ห้าม Publish to web)
 *   doGet  = ส่งข้อมูลที่ล้างแล้วให้บอท (ต้องส่ง ?key=KEY)
 *   doPost = บันทึกเรื่องส่งต่อเจ้าหน้าที่ลงชีท "รอติดต่อกลับ"
 * ติดตั้ง: Extensions → Apps Script → วางไฟล์นี้ → แก้ KEY
 *   → Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone
 */
const KEY = 'CHANGE_ME'; // ต้องตรงกับ APPS_SCRIPT_KEY ใน Vercel

const SHEET_NAMES = {
  faq: 'FAQ',
  price: 'ราคา',
  branch: 'สต๊อกสาขา',
  warehouses: ['สต๊อกคลังอุบล', 'สต๊อกคลังสุรินทร์', 'สต๊อกคลังร้อยเอ็ด'],
  handoff: 'รอติดต่อกลับ',
};

const REASON = {
  cut_branch: 'ขอตัดของสาขา',
  requisition: 'ขอเบิกสินค้า',
  order_check: 'ตรวจสอบการสั่งสินค้า',
  out_of_stock: 'สินค้าไม่มีในสต๊อก',
  special_order: 'สั่งสินค้ารุ่นพิเศษ',
  app_issue: 'ปัญหาการใช้งานแอป',
  installment: 'ถามเรื่องผ่อน',
  not_in_faq: 'ไม่มีข้อมูลใน FAQ',
  not_in_sheet: 'ไม่มีข้อมูลสินค้าในชีท',
  sheet_error: 'ดึงชีทไม่ได้',
  gemini_error: 'AI ขัดข้อง/เกินเวลา',
  max_tokens: 'AI ตอบไม่จบ',
  non_text: 'ส่งสติกเกอร์/รูป',
};

const HANDOFF_HEADERS = [
  'เวลา', 'ชื่อลูกค้า', 'userId', 'สาเหตุ', 'สาขา', 'สินค้า', 'คำถาม', 'สถานะ', 'ผู้รับเรื่อง',
];

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  if (!e || !e.parameter || e.parameter.key !== KEY) return json_({ error: 'forbidden' });
  return json_(buildData_());
}

function doPost(e) {
  let b;
  try {
    b = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ error: 'bad request' });
  }
  if (b.key !== KEY) return json_({ error: 'forbidden' });

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const sheet = handoffSheet_();
    sheet.appendRow([
      new Date(),
      b.displayName || '',
      b.userId || '',
      REASON[b.reason] || b.reason || '',
      b.branch || '',
      b.product || '',
      String(b.question || '').slice(0, 500),
      'รอดำเนินการ',
      '',
    ]);
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true });
}

// สร้างชีท "รอติดต่อกลับ" ให้เองครั้งแรก (พร้อม dropdown สถานะ)
function handoffSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(SHEET_NAMES.handoff);
  if (sheet) return sheet;
  sheet = ss.insertSheet(SHEET_NAMES.handoff);
  sheet.appendRow(HANDOFF_HEADERS);
  sheet.setFrozenRows(1);
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['รอดำเนินการ', 'ติดต่อแล้ว', 'ปิดเรื่อง'], true)
    .build();
  sheet.getRange(2, 8, 1000, 1).setDataValidation(rule);
  return sheet;
}

/* ---------------- สร้างข้อมูลให้บอท ---------------- */

function buildData_() {
  const problems = [];
  const warehouse = parseWarehouseStock_(problems);
  return {
    updatedAt: new Date().toISOString(),
    faq: parseFaq_(grid_(SHEET_NAMES.faq, problems), problems),
    price: parsePrice_(grid_(SHEET_NAMES.price, problems), problems),
    branchStock: parseBranchStock_(grid_(SHEET_NAMES.branch, problems), problems),
    warehouseStock: warehouse.all,
    warehouses: warehouse.byArea,
    problems: problems,
  };
}

function grid_(name, problems) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) {
    problems.push('ไม่พบชีท "' + name + '"');
    return null;
  }
  return sheet.getDataRange().getDisplayValues();
}

function trim_(v) {
  return String(v === undefined || v === null ? '' : v).trim();
}

function toNum_(v) {
  const n = Number(trim_(v).replace(/,/g, ''));
  return isFinite(n) ? n : NaN;
}

// หา index ของหัวคอลัมน์ ไม่พบ → บันทึก problem
function colIndex_(head, title, sheetName, problems) {
  const i = head.indexOf(title);
  if (i < 0) problems.push(sheetName + ': ไม่พบหัวตาราง "' + title + '"');
  return i;
}

function parseFaq_(grid, problems) {
  if (!grid || !grid.length) return [];
  const head = grid[0].map(trim_);
  const cat = colIndex_(head, 'หมวด', SHEET_NAMES.faq, problems);
  const q = colIndex_(head, 'คำถาม', SHEET_NAMES.faq, problems);
  const a = colIndex_(head, 'คำตอบ', SHEET_NAMES.faq, problems);
  if (q < 0 || a < 0) return [];
  const on = head.indexOf('เปิดใช้'); // ไม่บังคับ: N = ซ่อน
  const out = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (on >= 0 && trim_(row[on]).toUpperCase() === 'N') continue;
    const question = trim_(row[q]);
    const answer = String(row[a] === undefined ? '' : row[a]).trim();
    if (!question || !answer) continue;
    out.push([cat >= 0 ? trim_(row[cat]) : '', question, answer]);
  }
  return out;
}

// ชีทราคาวาง 3 ช่องคู่กัน: รุ่น, ราคาตัดสด, ราคาปลีก, กำไร, (ว่าง) ×3
// แถวที่มีแต่ชื่อ = ยี่ห้อ · ตัดคอลัมน์กำไรทิ้ง · แถวที่ไม่มีราคาปลีกข้าม
function parsePrice_(grid, problems) {
  if (!grid || !grid.length) return [];
  const name = SHEET_NAMES.price;
  const head = grid[0].map(trim_);
  const blocks = [];
  head.forEach(function (h, j) {
    if (h !== 'รุ่น') return;
    let end = head.indexOf('รุ่น', j + 1);
    if (end < 0) end = head.length;
    let cash = -1;
    let retail = -1;
    for (let k = j + 1; k < end; k++) {
      if (head[k] === 'ราคาตัดสด' && cash < 0) cash = k;
      if (head[k] === 'ราคาปลีก' && retail < 0) retail = k;
    }
    if (cash < 0 || retail < 0) {
      problems.push(name + ': ช่องที่คอลัมน์ ' + (j + 1) + ' ขาด ราคาตัดสด/ราคาปลีก');
      return;
    }
    blocks.push({ m: j, cash: cash, retail: retail });
  });
  if (!blocks.length) {
    problems.push(name + ': ไม่พบหัวตาราง รุ่น/ราคาตัดสด/ราคาปลีก');
    return [];
  }
  const brands = blocks.map(function () { return ''; });
  const out = [];
  for (let r = 1; r < grid.length; r++) {
    blocks.forEach(function (b, i) {
      const model = trim_(grid[r][b.m]);
      if (!model) return;
      const cash = trim_(grid[r][b.cash]);
      const retail = trim_(grid[r][b.retail]);
      if (!cash && !retail) {
        brands[i] = model; // แถวยี่ห้อ
        return;
      }
      if (!(toNum_(cash) > 0) || !(toNum_(retail) > 0)) return;
      out.push([brands[i], model, cash, retail]);
    });
  }
  return out;
}

// สต๊อกสาขา → [สาขา, ชื่อสินค้า] เฉพาะผลรวม > 0 ตัด "RT-" ออก ไม่ส่งจำนวน
function parseBranchStock_(grid, problems) {
  if (!grid || !grid.length) return [];
  const name = SHEET_NAMES.branch;
  const head = grid[0].map(trim_);
  const b = colIndex_(head, 'คลัง', name, problems);
  const p = colIndex_(head, 'ชื่อสินค้า', name, problems);
  const q = colIndex_(head, 'ผลรวม', name, problems);
  if (b < 0 || p < 0 || q < 0) return [];
  const out = [];
  for (let r = 1; r < grid.length; r++) {
    const branch = trim_(grid[r][b]).replace(/^RT-/, '');
    const product = trim_(grid[r][p]);
    if (branch && product && toNum_(grid[r][q]) > 0) out.push([branch, product]);
  }
  return out;
}

// all = รายชื่อสินค้าที่ 3 คลังรวมกันมีของ · byArea = รายชื่อที่มีของแยกตามพื้นที่ (ไม่ส่งจำนวน)
function parseWarehouseStock_(problems) {
  const totals = {};
  const order = [];
  const byArea = {};
  SHEET_NAMES.warehouses.forEach(function (sheetName) {
    const grid = grid_(sheetName, problems);
    if (!grid || !grid.length) return;
    const head = grid[0].map(trim_);
    const p = colIndex_(head, 'ชื่อสินค้า', sheetName, problems);
    const q = colIndex_(head, 'ผลรวม', sheetName, problems);
    if (p < 0 || q < 0) return;
    const areaTotals = {};
    for (let r = 1; r < grid.length; r++) {
      const product = trim_(grid[r][p]);
      if (!product) continue;
      areaTotals[product] = (areaTotals[product] || 0) + (toNum_(grid[r][q]) > 0 ? toNum_(grid[r][q]) : 0);
      if (!(product in totals)) {
        totals[product] = 0;
        order.push(product);
      }
      const n = toNum_(grid[r][q]);
      totals[product] += n > 0 ? n : 0;
    }
    byArea[sheetName.replace('สต๊อกคลัง', '')] = Object.keys(areaTotals).filter(function (k) {
      return areaTotals[k] > 0;
    });
  });
  return {
    all: order.filter(function (n) { return totals[n] > 0; }),
    byArea: byArea,
  };
}
