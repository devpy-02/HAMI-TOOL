import React, { useMemo, useState } from 'react';
import { FileText, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Product, User } from '../types';
import { StorageService } from '../services/storageService';
import { parsePriceListLines, matchRows, MatchResult } from '../utils/priceListParser';
import { extractPdfLines } from '../utils/pdfText';
import { BuyPriceConflictModal, ConflictRow } from './BuyPriceConflictModal';
import { toPersianDigits, formatToman } from '../utils/jalali';

interface Props {
  products: Product[];
  currentUser: User;
  onChanged: () => void;
}

interface Sel {
  include: boolean;
  productId: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  exact: 'کد دقیق',
  sure: 'مطمئن',
  maybe: 'مشکوک',
  none: 'بدون تطبیق',
};
const STATUS_COLOR: Record<string, string> = {
  exact: 'bg-emerald-100 text-emerald-800',
  sure: 'bg-emerald-50 text-emerald-700',
  maybe: 'bg-amber-100 text-amber-800',
  none: 'bg-slate-200 text-slate-700',
};

// ورود لیست قیمت PDF تامین‌کننده: تطبیق با کالاها، پیش‌نمایش، و اعمال قیمت خرید (عمده)
export const PriceListImportView: React.FC<Props> = ({ products, currentUser, onChanged }) => {
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [debugLines, setDebugLines] = useState<string[]>([]);
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [sel, setSel] = useState<Sel[]>([]);
  const [filter, setFilter] = useState<'all' | 'sure' | 'maybe' | 'none'>('all');
  const [conflicts, setConflicts] = useState<ConflictRow[] | null>(null);
  const [pending, setPending] = useState<{ productId: string; code: string; newBuy: number }[]>([]);
  const [result, setResult] = useState('');

  const active = useMemo(
    () => products.filter((p) => !p.deleted).sort((a, b) => a.name.localeCompare(b.name, 'fa')),
    [products]
  );

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');
    setResult('');
    setConflicts(null);
    setFileName(file.name);
    try {
      const lines = await extractPdfLines(file);
      const rows = parsePriceListLines(lines);
      if (rows.length === 0) {
        setError('هیچ ردیف کالایی در این فایل پیدا نشد. مطمئن شو PDF متنی است (نه اسکن عکس).');
        setMatches([]);
        setSel([]);
        setDebugLines(lines.slice(0, 15));
        return;
      }
      const m = matchRows(rows, active);
      setMatches(m);
      setSel(
        m.map((x) => ({
          include: (x.status === 'exact' || x.status === 'sure') && !x.row.duplicate,
          productId: x.productId,
        }))
      );
      setDebugLines(lines.slice(0, 15));
    } catch (e: any) {
      setError('خواندن PDF انجام نشد: ' + (e?.message || 'خطای ناشناخته'));
    } finally {
      setBusy(false);
    }
  };

  const shown = matches
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => filter === 'all' || m.status === filter || (filter === 'sure' && m.status === 'exact'))
    .slice(0, 200);

  const counts = useMemo(() => {
    const c = { exact: 0, sure: 0, maybe: 0, none: 0 };
    matches.forEach((m) => { c[m.status]++; });
    return c;
  }, [matches]);

  // کالاهایی که واقعاً اعمال می‌شوند (بدون تکرار کالا)
  const buildPlan = () => {
    const seen = new Set<string>();
    const plan: { productId: string; code: string; newBuy: number }[] = [];
    matches.forEach((m, i) => {
      const s = sel[i];
      if (!s || !s.include || !s.productId || seen.has(s.productId)) return;
      seen.add(s.productId);
      plan.push({ productId: s.productId, code: m.row.code, newBuy: m.row.wholesale });
    });
    return plan;
  };

  const apply = (plan: { productId: string; code: string; newBuy: number }[], decisions: Record<string, boolean>) => {
    let changed = 0;
    let loss = 0;
    plan.forEach((it) => {
      if (StorageService.applyBuyPriceChange(it.productId, it.newBuy, currentUser, decisions[it.productId] === true)) changed++;
      StorageService.setSupplierCode(it.productId, it.code);
      const p = StorageService.getProducts().find((x) => x.id === it.productId);
      if (p && p.buyPrice && p.price < p.buyPrice) loss++;
    });
    setConflicts(null);
    setPending([]);
    setResult(
      `${toPersianDigits(plan.length)} کالا تطبیق و ثبت شد. ` +
        `قیمت خرید ${toPersianDigits(changed)} کالا عوض شد.` +
        (loss ? ` هشدار: ${toPersianDigits(loss)} کالا اکنون زیر قیمت خرید فروخته می‌شوند.` : '')
    );
    onChanged();
  };

  const startApply = () => {
    setResult('');
    const plan = buildPlan();
    if (!plan.length) {
      setError('هیچ کالایی انتخاب نشده است.');
      return;
    }
    setError('');
    const rows: ConflictRow[] = [];
    plan.forEach((it) => {
      const prod = StorageService.getProducts().find((p) => p.id === it.productId);
      if (!prod) return;
      const c = StorageService.buyPriceConflict(prod, it.newBuy);
      if (c) rows.push({ key: it.productId, name: prod.name, newBuy: it.newBuy, current: c.current, target: c.target });
    });
    setPending(plan);
    if (rows.length) setConflicts(rows);
    else apply(plan, {});
  };

  const box = 'bg-white dark:bg-slate-850 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-3';
  const input = 'w-full px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs';

  return (
    <div className="space-y-4 pb-24">
      <div className="bg-gradient-to-r from-sky-700 to-blue-800 text-white p-5 rounded-2xl shadow-lg">
        <div className="flex items-center gap-2">
          <span className="bg-white/20 p-2 rounded-xl"><FileText className="w-6 h-6" /></span>
          <h2 className="text-lg font-extrabold">ورود لیست قیمت PDF</h2>
        </div>
        <p className="text-xs text-sky-100 mt-1">قیمت عمده به‌عنوان قیمت خرید ثبت می‌شود. تطبیق اول با کد، بعد با نام انجام می‌شود.</p>
      </div>

      <div className={box}>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => handleFile(e.target.files?.[0])}
          className="w-full text-xs"
        />
        {busy && <p className="text-xs text-slate-500">در حال خواندن فایل {fileName}...</p>}
        {error && (
          <div className="flex items-center gap-2 text-xs text-rose-600 bg-rose-50 dark:bg-rose-950/40 p-2 rounded-lg">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {result && (
          <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 p-2 rounded-lg">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>{result}</span>
          </div>
        )}
      </div>

      {matches.length > 0 && (
        <>
          <div className={box}>
            <p className="text-xs font-bold">
              {toPersianDigits(matches.length)} ردیف از «{fileName}» · کد دقیق {toPersianDigits(counts.exact)} · مطمئن {toPersianDigits(counts.sure)} · مشکوک {toPersianDigits(counts.maybe)} · بدون تطبیق {toPersianDigits(counts.none)}
            </p>
            <div className="flex gap-1.5 flex-wrap text-[11px]">
              {(['all', 'sure', 'maybe', 'none'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={`px-2.5 py-1 rounded-lg font-bold ${filter === f ? 'bg-slate-800 text-white' : 'bg-slate-100 dark:bg-slate-800'}`}
                >
                  {f === 'all' ? 'همه' : f === 'sure' ? 'مطمئن' : f === 'maybe' ? 'مشکوک' : 'بدون تطبیق'}
                </button>
              ))}
            </div>

            <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
              {shown.map(({ m, i }) => (
                <div key={i} className={`p-2 rounded-xl border text-[11px] space-y-1.5 ${m.row.duplicate ? 'border-rose-300' : 'border-slate-200 dark:border-slate-700'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-1.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={!!sel[i]?.include}
                        onChange={(e) => setSel((s) => s.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))}
                      />
                      <span className="font-bold truncate">{m.row.name}</span>
                    </label>
                    <span className={`px-1.5 py-0.5 rounded-md font-bold shrink-0 ${STATUS_COLOR[m.status]}`}>{STATUS_LABEL[m.status]}</span>
                  </div>
                  <div className="text-slate-500">
                    کد {m.row.code} · عمده {formatToman(m.row.wholesale)}
                    {m.row.minQty ? ` (خرید بالای ${toPersianDigits(m.row.minQty)} عدد)` : ''}
                    {m.row.retail ? ` · تک ${formatToman(m.row.retail)}` : ''}
                    {m.row.duplicate && <span className="text-rose-600 font-bold"> · کد تکراری در فایل</span>}
                  </div>
                  <select
                    value={sel[i]?.productId || ''}
                    onChange={(e) => setSel((s) => s.map((x, j) => (j === i ? { ...x, productId: e.target.value || null } : x)))}
                    className={input}
                  >
                    <option value="">— کالای انبار را انتخاب کن —</option>
                    {active.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.buyPrice ? ` (خرید فعلی ${formatToman(p.buyPrice)})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              {matches.length > 200 && shown.length === 200 && (
                <p className="text-[11px] text-slate-500">فقط ۲۰۰ ردیف اول نمایش داده می‌شود. با فیلتر، بقیه را ببین.</p>
              )}
            </div>

            <button type="button" onClick={startApply} className="w-full py-2.5 rounded-xl bg-amber-600 text-white text-xs font-bold">
              اعمال قیمت‌های انتخاب‌شده
            </button>
          </div>
        </>
      )}

      {debugLines.length > 0 && (
        <details className={box}>
          <summary className="text-xs font-bold cursor-pointer">متن خوانده‌شده از PDF (برای بررسی)</summary>
          <div className="mt-2 space-y-1 text-[10px] font-mono text-slate-600 dark:text-slate-300 break-words">
            {debugLines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </details>
      )}

      {conflicts && (
        <BuyPriceConflictModal
          rows={conflicts}
          onCancel={() => { setConflicts(null); setPending([]); }}
          onConfirm={(d) => apply(pending, d)}
        />
      )}
    </div>
  );
};
