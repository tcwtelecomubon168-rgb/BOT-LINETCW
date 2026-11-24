// จำแชทล่าสุดต่อลูกค้า (ใน memory — Vercel อาจเริ่มเครื่องใหม่ทำให้หาย ยอมรับได้)
export type HistoryItem = { role: "user" | "admin"; text: string };

const MAX_ITEMS = 6;
const TTL_MS = 30 * 60_000;
const store = new Map<string, { items: HistoryItem[]; at: number }>();

export function getHistory(userId: string): HistoryItem[] {
  const now = Date.now();
  for (const [k, v] of Array.from(store)) if (now - v.at > TTL_MS) store.delete(k);
  return store.get(userId)?.items.slice() ?? [];
}

export function pushHistory(userId: string, role: HistoryItem["role"], text: string): void {
  const cur = store.get(userId);
  const items = [...(cur?.items ?? []), { role, text }].slice(-MAX_ITEMS);
  store.set(userId, { items, at: Date.now() });
}
