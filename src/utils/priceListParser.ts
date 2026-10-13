// تحلیل متن لیست قیمت تامین‌کننده و تطبیق آن با کالاهای انبار

export interface PriceListRow {
  code: string;
  name: string;
  wholesale: number;     // قیمت عمده (قیمت خرید)
  minQty: number | null; // حداقل تعداد برای قیمت عمده
  retail: number | null; // قیمت تک (مرجع)
  duplicate: boolean;    // کد تکراری در همین فایل
}

export type MatchStatus = 'exact' | 'sure' | 'maybe' | 'none';

export interface MatchResult {
  row: PriceListRow;
  productId: string | null;
  score: number;
  status: MatchStatus;
}

// حذف نشانه‌های جهت‌نما و نیم‌فاصله، و تبدیل اعداد فارسی/عربی به لاتین
export function cleanText(s: string): string {
  return s
    .replace(/[\u200c\u200d\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

const toNum = (s: string) => Number(s.replace(/,/g, ''));

/** خطوط خام PDF را به ردیف‌های کالا تبدیل می‌کند */
export function parsePriceListLines(lines: string[]): PriceListRow[] {
  const rows: PriceListRow[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = cleanText(raw).replace(/\s+/g, ' ');
    const codeM = /کد\s*(\d{3,7})\s*:?/.exec(line);
    const whM = /عمده\s*([\d,]+)\s*:?/.exec(line);
    if (!codeM || !whM) continue;
    const retM = /تک\s*([\d,]+)\s*:?/.exec(line);
    const qtyM = /خرید باالی\s*(\d+)\s*عدد/.exec(line);
    const afterPrice = Math.max(
      whM.index + whM[0].length,
      retM ? retM.index + retM[0].length : 0
    );
    const name = line.slice(afterPrice, codeM.index).replace(/[:|]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const code = codeM[1];
    rows.push({
      code,
      name,
      wholesale: toNum(whM[1]),
      minQty: qtyM ? Number(qtyM[1]) : null,
      retail: retM ? toNum(retM[1]) : null,
      duplicate: seen.has(code),
    });
    seen.add(code);
  }
  return rows;
}

/** نرمال‌سازی نام برای مقایسه */
export function normalizeName(s: string): string {
  return cleanText(s)
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ۀ/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// شباهت Dice روی کلمات: بین ۰ و ۱
export function similarity(a: string, b: string): number {
  const A = new Set(normalizeName(a).split(' ').filter(Boolean));
  const B = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((t) => { if (B.has(t)) inter++; });
  let score = (2 * inter) / (A.size + B.size);
  // اگر عددهای دو نام (سایز، تعداد، ابعاد) فرق دارند، تطبیق مطمئن نیست
  const numsA = [...A].filter((t) => /\d/.test(t)).sort().join(' ');
  const numsB = [...B].filter((t) => /\d/.test(t)).sort().join(' ');
  if ((numsA || numsB) && numsA !== numsB) score *= 0.6;
  return score;
}

/** تطبیق ردیف‌ها با کالاهای انبار: اول کد دقیق، بعد نام */
export function matchRows(
  rows: PriceListRow[],
  products: { id: string; name: string; supplierCode?: string; deleted?: boolean }[]
): MatchResult[] {
  const active = products.filter((p) => !p.deleted);
  const byCode = new Map<string, string>();
  active.forEach((p) => { if (p.supplierCode) byCode.set(p.supplierCode, p.id); });

  return rows.map((row) => {
    const exactId = byCode.get(row.code);
    if (exactId) return { row, productId: exactId, score: 1, status: 'exact' as MatchStatus };
    let bestId: string | null = null;
    let bestScore = 0;
    for (const p of active) {
      const score = similarity(row.name, p.name);
      if (score > bestScore) { bestScore = score; bestId = p.id; }
    }
    if (!bestId || bestScore < 0.5) return { row, productId: null, score: bestScore, status: 'none' as MatchStatus };
    return {
      row,
      productId: bestId,
      score: bestScore,
      status: (bestScore >= 0.8 ? 'sure' : 'maybe') as MatchStatus,
    };
  });
}
