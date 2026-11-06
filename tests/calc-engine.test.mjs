// 台股當沖・融資融券計算機 — 計算引擎測試（node --test tests/）
//
// 引擎來源：
//   - 預設：讀取 ../index.html，以 regex 擷取 <script id="tw-calc-engine">…</script>，在 node:vm 執行後取 TWCalc。
//   - 開發：設定環境變數 TWCALC_ENGINE_PATH=<engine.js 路徑> 則改讀該 JS 檔。
// 所有測試都明確傳入 tradeDate，不依賴系統日期。
// 期望值皆為手算（算式寫在註解），隨機對帳測試另以本檔內獨立的 BigInt 參考模型比對。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadEngine() {
  const override = process.env.TWCALC_ENGINE_PATH;
  let code;
  let origin;
  if (override) {
    origin = path.resolve(override);
    code = fs.readFileSync(origin, 'utf8');
  } else {
    origin = path.resolve(HERE, '..', 'index.html');
    const html = fs.readFileSync(origin, 'utf8');
    const m = /<script\b[^>]*\bid\s*=\s*["']tw-calc-engine["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (!m) throw new Error(`${origin} 找不到 <script id="tw-calc-engine">；開發時可設定 TWCALC_ENGINE_PATH 指向 engine.js`);
    code = m[1];
  }
  const context = vm.createContext({});
  vm.runInContext(code, context, { filename: origin });
  if (!context.TWCalc) throw new Error('引擎沒有設定 globalThis.TWCalc');
  return context.TWCalc;
}

const T = loadEngine();
const DATE = '2026-11-06'; // 融券最低成數 90%、當沖降稅期間內
// vm context 的物件屬於另一個 realm（Array/Object prototype 不同），deepStrictEqual 前先轉成本 realm 的純資料
const plain = (x) => JSON.parse(JSON.stringify(x));
const calc = (over) => T.calculate({ ...T.getDefaults(), tradeDate: DATE, ...over });
const codes = (r) => r.warnings.map((w) => w.code);
const hasWarn = (r, code) => codes(r).includes(code);

// ════════════════════════════════════════════════════════════════════
// 一、稽核重現案例（code-audit.json）
// ════════════════════════════════════════════════════════════════════
describe('稽核重現案例', () => {
  test('[F01] 融資 2 張 100 元、自備 55% → 融資金額 90,000（不可因浮點少 1,000）', () => {
    // G = 100 × 2000 = 200,000；loan = ⌊200,000 × 45% / 1000⌋ × 1000 = 90,000；自備 110,000
    // 手續費 = ⌊200,000 × 0.1425% × 0.18⌋ = ⌊51.3⌋ = 51；進場應付 = 110,051
    // 維持率 = 200,000 / 90,000 = 222.22%；追繳價 = ceil_tick(130% × 90,000 / 2000 = 58.50) = 58.5
    const r = calc({ tradeMode: 'marginLong', direction: 'long', lots: '2', entryPrice: '100', marginSelfRatio: '55' });
    assert.equal(r.ok, true);
    assert.equal(r.entry.gross, 200000);
    assert.equal(r.entry.loan, 90000);
    assert.equal(r.entry.selfFunds, 110000);
    assert.equal(r.entry.commission.charged, 51);
    assert.equal(r.entry.cashOut, 110051);
    assert.equal(T.format.maintenance(r.entry.maintenance), '222.22%');
    assert.equal(r.entry.marginCallPrice, 58.5);
    assert.equal(r.entry.marginCallDirection, 'below');
    assert.equal(hasWarn(r, 'SELF_RATIO_CLAMPED'), false);
  });

  test('[F01] 16.50 元 × 20 張、自備 30% → 夾到 40% 並警示，融資 198,000', () => {
    // 自備 30%（融資 7 成）超過法定上限 → 以 40% 計；G = 330,000；loan = ⌊330,000 × 60% / 1000⌋ × 1000 = 198,000
    const r = calc({ tradeMode: 'marginLong', direction: 'long', lots: '20', entryPrice: '16.50', marginSelfRatio: '30' });
    assert.equal(r.ok, true);
    assert.equal(hasWarn(r, 'SELF_RATIO_CLAMPED'), true);
    assert.equal(r.inputs.marginSelfRatio, 40);
    assert.equal(r.credit.selfRatio, 0.4);
    assert.equal(r.entry.loan, 198000);
    assert.equal(r.entry.selfFunds, 132000);
  });

  test('[F01] 4.60 元 × 25 張、自備 40% → 融資 69,000', () => {
    // G = 4.60 × 25,000 = 115,000（浮點為 114999.99999999999）；loan = ⌊115,000 × 60% / 1000⌋ × 1000 = 69,000
    const r = calc({ tradeMode: 'marginLong', direction: 'long', lots: '25', entryPrice: '4.60', marginSelfRatio: '40' });
    assert.equal(r.entry.gross, 115000);
    assert.equal(r.entry.loan, 69000);
  });

  test('[F02] 融券 10.3 元 × 3 張、成數 100% → 保證金 30,900（不可多算 100）', () => {
    // tradeDate 2026-11-06 最低 90%；G = 30,900；保證金 = ⌈30,900 × 100% / 100⌉ × 100 = 30,900
    const r = calc({ tradeMode: 'marginShort', direction: 'short', lots: '3', entryPrice: '10.3', shortMarginRatio: '100' });
    assert.equal(r.entry.gross, 30900);
    assert.equal(r.entry.collateral, 30900);
    assert.equal(r.entry.cashOut, 30900);
  });

  test('[F02] 融券 8.88 元 × 50 張、成數 90% → 保證金 399,600', () => {
    // G = 444,000；⌈444,000 × 90% / 100⌉ × 100 = ⌈3,996⌉ × 100 = 399,600
    const r = calc({ tradeMode: 'marginShort', direction: 'short', lots: '50', entryPrice: '8.88', shortMarginRatio: '90' });
    assert.equal(r.entry.collateral, 399600);
    assert.equal(hasWarn(r, 'SHORT_MARGIN_RAISED'), false);
  });

  test('[F02／E4] 2026-11-09 起輸入 100%（介於常態最低 90% 與臨時措施 130% 之間）→ 照 100% 計算並警示 SHORT_MARGIN_BELOW_MIN（保證金 30,900）', () => {
    // 主代理裁決（V-05）：130% 為未定結束日的臨時措施，使用者明確輸入 ≥ 90% 時照輸入計算，只警示不夾值
    // ⌈30,900 × 100% / 100⌉ × 100 = 30,900；空白（自動）才採 130%：⌈30,900 × 130% / 100⌉ × 100 = ⌈401.7⌉ × 100 = 40,200
    const r = calc({ tradeDate: '2026-11-09', tradeMode: 'marginShort', direction: 'short', lots: '3', entryPrice: '10.3', shortMarginRatio: '100' });
    assert.equal(hasWarn(r, 'SHORT_MARGIN_RAISED'), false);
    assert.equal(hasWarn(r, 'SHORT_MARGIN_BELOW_MIN'), true);
    const w = r.warnings.find((x) => x.code === 'SHORT_MARGIN_BELOW_MIN');
    assert.equal(w.level, 'warn');
    assert.equal(w.field, 'shortMarginRatio');
    assert.match(w.message, /低於 2026-11-09 起的最低融券保證金成數 130%（金管會臨時穩定措施）；除非措施已解除，券商不會接受此成數/);
    assert.equal(r.credit.marginRatio, 1);
    assert.equal(r.credit.marginRatioAuto, false);
    assert.equal(r.entry.collateral, 30900);
    assert.equal(r.inputs.shortMarginRatio, 100);
    const auto = calc({ tradeDate: '2026-11-09', tradeMode: 'marginShort', direction: 'short', lots: '3', entryPrice: '10.3', shortMarginRatio: '' });
    assert.equal(auto.entry.collateral, 40200);
    assert.equal(hasWarn(auto, 'SHORT_MARGIN_BELOW_MIN'), false);
  });

  test('[F03] 當沖 43.45 × 3 張、0.28 折 → 兩平 43.55（整數比較，不多跳一檔）', () => {
    // G = 130,350；進場費 ⌊130,350 × 0.1425% × 0.28⌋ = ⌊52.0097⌋ = 52
    // 43.55：EG = 130,650；出場費 ⌊52.129⌋ = 52；稅 ⌊130,650 × 0.15%⌋ = ⌊195.975⌋ = 195 → 損益 = 300 − 52 − 52 − 195 = +1
    // 43.50：EG = 130,500；費 52；稅 ⌊195.75⌋ = 195 → 損益 = 150 − 299 = −149
    const r = calc({ tradeMode: 'dayTrade', direction: 'long', lots: '3', entryPrice: '43.45', discount: '0.28' });
    assert.equal(r.breakEven.exitPrice, 43.55);
    assert.equal(r.breakEven.ticks, 2);
    assert.equal(r.breakEven.profit, 1);
    assert.equal(r.breakEven.reachable, true);
    const prev = calc({ tradeMode: 'dayTrade', direction: 'long', lots: '3', entryPrice: '43.45', discount: '0.28', exitPrice: '43.50' });
    assert.equal(prev.manualExit.profit, -149);
    // 證交稅四捨五入：43.55 的稅 = round(195.975) = 196 → 損益恰為 0，仍須判定為兩平（舊版浮點 −2.9e-11 會多跳一檔）
    const rr = calc({ tradeMode: 'dayTrade', direction: 'long', lots: '3', entryPrice: '43.45', discount: '0.28', taxRounding: 'round' });
    assert.equal(rr.breakEven.exitPrice, 43.55);
    assert.equal(rr.breakEven.profit, 0);
    assert.ok(Object.is(rr.breakEven.profit, 0));
  });

  test('[F03] 同型例 86.90 × 3 張、0.28 折 → 兩平 87.10', () => {
    // G = 260,700；費 ⌊104.02⌋ = 104；87.10：EG = 261,300、費 ⌊104.26⌋ = 104、稅 ⌊391.95⌋ = 391 → +1；87.00：稅 391、損益 −299
    const r = calc({ tradeMode: 'dayTrade', direction: 'long', lots: '3', entryPrice: '86.90', discount: '0.28' });
    assert.equal(r.breakEven.exitPrice, 87.1);
    assert.equal(r.breakEven.profit, 1);
  });

  test('[F05] 融資自備 100% → 未動用融資：維持率 null、追繳價 null、無追繳警示', () => {
    const r = calc({ tradeMode: 'marginLong', direction: 'long', lots: '10', entryPrice: '100', marginSelfRatio: '100', exitPrice: '101' });
    assert.equal(r.entry.loan, 0);
    assert.equal(r.entry.maintenance, null);
    assert.equal(r.entry.marginCallPrice, null);
    assert.equal(r.entry.marginCallDirection, null);
    assert.equal(r.entry.interest, 0);
    assert.equal(r.manualExit.maintenance, null);
    assert.equal(r.manualExit.belowCall, false);
    assert.equal(hasWarn(r, 'ZERO_LOAN'), true);
    assert.equal(hasWarn(r, 'EXIT_BELOW_CALL'), false);
    // 另例：1 張 1.5 元、自備 40% → 融資 ⌊1,500 × 60% / 1000⌋ × 1000 = 0
    const r2 = calc({ tradeMode: 'marginLong', direction: 'long', lots: '1', entryPrice: '1.5', marginSelfRatio: '40', exitPrice: '1.4' });
    assert.equal(r2.entry.loan, 0);
    assert.equal(r2.entry.maintenance, null);
    assert.equal(r2.manualExit.belowCall, false);
    assert.equal(hasWarn(r2, 'ZERO_LOAN'), true);
  });

  test('[F08] ETF 53.6 × 10 張自備 40%、出場 41.73（追繳價本身）→ 不得標示低於 130%', () => {
    // G = 536,000；loan = ⌊321.6⌋ × 1000 = 321,000；追繳價 = ceil_tick(130% × 321,000 / 10,000 = 41.73) = 41.73
    // 41.73：EG = 417,300；417,300 × 100 = 41,730,000 = 130 × 321,000 → 不低於 130%
    const r = calc({ tradeMode: 'marginLong', direction: 'long', productType: 'etf', lots: '10', entryPrice: '53.6', marginSelfRatio: '40', marginDays: '0', exitPrice: '41.73' });
    assert.equal(r.entry.loan, 321000);
    assert.equal(r.entry.marginCallPrice, 41.73);
    assert.equal(r.manualExit.exitGross, 417300);
    assert.equal(r.manualExit.belowCall, false);
    assert.equal(hasWarn(r, 'EXIT_BELOW_CALL'), false);
    assert.equal(T.format.maintenance(r.manualExit.maintenance), '130.00%');
    // 下一檔 41.72：417,200 × 100 < 130 × 321,000 → 追繳
    const r2 = calc({ tradeMode: 'marginLong', direction: 'long', productType: 'etf', lots: '10', entryPrice: '53.6', marginSelfRatio: '40', marginDays: '0', exitPrice: '41.72' });
    assert.equal(r2.manualExit.belowCall, true);
    assert.equal(hasWarn(r2, 'EXIT_BELOW_CALL'), true);
  });

  test('[F04] 融券對帳：出場應收 − 進場應付 = 淨損益（10 張 100 元、出場 95）', () => {
    // G = 1,000,000；費 ⌊256.5⌋ = 256；稅 ⌊3,000⌋ = 3,000；融券手續費 round(800) = 800
    // 保證金 = 900,000（90%）；擔保價款 = 1,000,000 − 256 − 3,000 − 800 = 995,944；進場應付 = 只有保證金 900,000
    // 利息收入 = round((900,000 + 995,944) × 0.2% × 30 / 365) = round(311.66) = 312
    // 出場 95：EG = 950,000；費 ⌊243.675⌋ = 243；融券回補應收 = 900,000 + 995,944 − 950,000 − 243 + 312 = 946,013
    // 淨損益 = 50,000 − (256 + 3,000 + 800 + 243) + 312 = 46,013 = 946,013 − 900,000
    const r = calc({ tradeMode: 'marginShort', direction: 'short', lots: '10', entryPrice: '100', exitPrice: '95' });
    const e = r.entry;
    assert.deepEqual([e.gross, e.commission.charged, e.tax, e.shortFee, e.collateral, e.guaranty, e.cashOut, e.cashIn, e.interest],
      [1000000, 256, 3000, 800, 900000, 995944, 900000, 0, 312]);
    assert.equal(T.format.maintenance(e.maintenance), '189.59%');
    assert.equal(e.marginCallPrice, 145.5); // ⌊(1,895,944 / 1.3 / 10,000) = 145.84⌋_tick(0.5) = 145.5
    assert.equal(e.marginCallDirection, 'above');
    const x = r.manualExit;
    assert.equal(x.exitCommission.charged, 243);
    assert.equal(x.interest, 312);
    assert.equal(x.interestType, 'income');
    assert.equal(x.settlement.label, '融券回補應收');
    assert.equal(x.settlement.amount, 946013);
    assert.equal(x.profit, 46013);
    assert.equal(x.settlement.amount - e.cashOut, x.profit);
    assert.equal(x.totalCosts, 256 + 3000 + 800 + 243 - 312);
    assert.equal(x.returnRate, 46013 / 900000); // 保證金報酬率
    assert.equal(e.returnRateLabel, '保證金報酬率');
  });

  test('[F04] 融券對帳（月退制）：出場應收 − 進場應付 + 退款 = 淨損益', () => {
    // 月退：進場收 ⌊1,425⌋ = 1,425、退 ⌊1,425 × 0.82⌋ = 1,168；出場 950,000：收 ⌊1,353.75⌋ = 1,353、退 ⌊1,109.46⌋ = 1,109
    const r = calc({ tradeMode: 'marginShort', direction: 'short', lots: '10', entryPrice: '100', exitPrice: '95', feeModel: 'monthly' });
    const e = r.entry;
    const x = r.manualExit;
    assert.deepEqual(plain(e.commission), { charged: 1425, refund: 1168, net: 257 });
    assert.deepEqual(plain(x.exitCommission), { charged: 1353, refund: 1109, net: 244 });
    assert.equal(e.guaranty, 1000000 - 1425 - 3000 - 800); // 擔保價款以交割實收（charged）扣除
    assert.equal(x.settlement.amount - e.cashOut + e.commission.refund + x.exitCommission.refund, x.profit);
  });
});

// ════════════════════════════════════════════════════════════════════
// 二、規則
// ════════════════════════════════════════════════════════════════════
describe('規則：證交稅', () => {
  test('[稅率] 現股當沖 2027-12-31 為 0.15%；2028-01-03 回到 0.3% 並警示 TAX_CUT_EXPIRED', () => {
    const a = T.resolveTaxRate({ productType: 'stock', tradeMode: 'dayTrade', tradeDate: '2027-12-31' });
    assert.equal(a.rate, 0.0015);
    const b = T.resolveTaxRate({ productType: 'stock', tradeMode: 'dayTrade', tradeDate: '2028-01-03' });
    assert.equal(b.rate, 0.003);
    assert.ok(b.warnings.some((w) => w.code === 'TAX_CUT_EXPIRED'));
    // 端到端：10 張 100 元先買後賣、出場 100 → 稅 = ⌊1,000,000 × 0.15%⌋ = 1,500 vs ⌊× 0.3%⌋ = 3,000
    const r1 = calc({ tradeDate: '2027-12-31', tradeMode: 'dayTrade', lots: '10', entryPrice: '100', exitPrice: '100' });
    const r2 = calc({ tradeDate: '2028-01-03', tradeMode: 'dayTrade', lots: '10', entryPrice: '100', exitPrice: '100' });
    assert.equal(r1.manualExit.exitTax, 1500);
    assert.equal(r2.manualExit.exitTax, 3000);
    assert.equal(hasWarn(r2, 'TAX_CUT_EXPIRED'), true);
    assert.equal(hasWarn(r1, 'TAX_CUT_EXPIRED'), false);
  });

  test('[稅率] 債券ETF 2026-12-31 停徵 0；2027-01-04 預設 0.1% 並警示 BOND_ETF_EXEMPTION_ENDED', () => {
    const a = T.resolveTaxRate({ productType: 'bondEtf', tradeMode: 'cash', tradeDate: '2026-12-31' });
    assert.equal(a.rate, 0);
    const b = T.resolveTaxRate({ productType: 'bondEtf', tradeMode: 'cash', tradeDate: '2027-01-04' });
    assert.equal(b.rate, 0.001);
    assert.ok(b.warnings.some((w) => w.code === 'BOND_ETF_EXEMPTION_ENDED'));
    const r1 = calc({ tradeDate: '2026-12-31', tradeMode: 'cash', productType: 'bondEtf', lots: '10', entryPrice: '30', exitPrice: '30' });
    const r2 = calc({ tradeDate: '2027-01-04', tradeMode: 'cash', productType: 'bondEtf', lots: '10', entryPrice: '30', exitPrice: '30' });
    assert.equal(r1.manualExit.exitTax, 0);
    assert.equal(r2.manualExit.exitTax, 300); // ⌊300,000 × 0.1%⌋
  });

  test('[稅率] 信用交易天數 0 仍為 0.3%（不得以天數 0 推論降稅）', () => {
    // 融資 0 天：出場稅 = ⌊1,000,000 × 0.3%⌋ = 3,000，利息 0
    const ml = calc({ tradeMode: 'marginLong', direction: 'long', lots: '10', entryPrice: '100', exitPrice: '100', marginDays: '0' });
    assert.equal(ml.tax.rate, 0.003);
    assert.equal(ml.manualExit.exitTax, 3000);
    assert.equal(ml.manualExit.interest, 0);
    // 融券 0 天：進場稅 3,000，利息收入 0
    const ms = calc({ tradeMode: 'marginShort', direction: 'short', lots: '10', entryPrice: '100', exitPrice: '100', shortDays: '0' });
    assert.equal(ms.tax.rate, 0.003);
    assert.equal(ms.entry.tax, 3000);
    assert.equal(ms.manualExit.interest, 0);
    // 資券當沖 0.3%
    const cd = calc({ tradeMode: 'creditDayTrade', direction: 'long', lots: '10', entryPrice: '100', exitPrice: '100' });
    assert.equal(cd.tax.rate, 0.003);
    assert.equal(cd.manualExit.exitTax, 3000);
  });

  test('[稅率] 模式 × 商品 × 日期矩陣', () => {
    const expected = {
      '2026-11-06': {
        stock: { dayTrade: 0.0015, cash: 0.003, marginLong: 0.003, marginShort: 0.003, creditDayTrade: 0.003 },
        etf: { dayTrade: 0.001, cash: 0.001, marginLong: 0.001, marginShort: 0.001, creditDayTrade: 0.001 },
        bondEtf: { dayTrade: 0, cash: 0, marginLong: 0, marginShort: 0, creditDayTrade: 0 },
      },
      '2028-01-03': {
        stock: { dayTrade: 0.003, cash: 0.003, marginLong: 0.003, marginShort: 0.003, creditDayTrade: 0.003 },
        etf: { dayTrade: 0.001, cash: 0.001, marginLong: 0.001, marginShort: 0.001, creditDayTrade: 0.001 },
        bondEtf: { dayTrade: 0.001, cash: 0.001, marginLong: 0.001, marginShort: 0.001, creditDayTrade: 0.001 },
      },
      '2017-04-27': { stock: { dayTrade: 0.003 } },
      '2017-04-28': { stock: { dayTrade: 0.0015 } },
    };
    for (const [date, byProd] of Object.entries(expected)) {
      for (const [prod, byMode] of Object.entries(byProd)) {
        for (const [mode, rate] of Object.entries(byMode)) {
          const got = T.resolveTaxRate({ productType: prod, tradeMode: mode, tradeDate: date }).rate;
          assert.equal(got, rate, `${date} ${prod} ${mode}`);
          const dir = mode === 'marginShort' ? 'short' : 'long';
          const r = calc({ tradeDate: date, tradeMode: mode, direction: dir, productType: prod, lots: '1', entryPrice: '30' });
          assert.equal(r.tax.rate, rate, `calculate ${date} ${prod} ${mode}`);
        }
      }
    }
  });

  test('[稅率] 進階覆寫取代預設並標示已自訂', () => {
    const a = T.resolveTaxRate({ productType: 'stock', tradeMode: 'cash', tradeDate: DATE, taxRateOverride: '0' });
    assert.equal(a.rate, 0);
    assert.equal(a.overridden, true);
    const r = calc({ tradeMode: 'cash', lots: '10', entryPrice: '100', exitPrice: '100', taxRateOverride: '0.1' });
    assert.equal(r.tax.overridden, true);
    assert.match(r.tax.label, /已自訂/);
    assert.equal(r.manualExit.exitTax, 1000); // ⌊1,000,000 × 0.1%⌋
    const bad = calc({ tradeMode: 'cash', lots: '10', entryPrice: '100', taxRateOverride: 'abc' });
    assert.equal(bad.tax.overridden, false);
    assert.equal(hasWarn(bad, 'TAX_OVERRIDE_INVALID'), true);
  });

  test('[證交稅取整] 預設 floor、可選四捨五入', () => {
    // 100,500 × 0.15% = 150.75 → floor 150 / round 151；507,000 × 0.15% = 760.5 → 760 / 761
    assert.equal(T.calculateTax(100500, 0.0015, 'floor'), 150);
    assert.equal(T.calculateTax(100500, 0.0015, 'round'), 151);
    assert.equal(T.calculateTax(507000, 0.0015), 760);
    assert.equal(T.calculateTax(507000, 0.0015, 'round'), 761);
    assert.equal(T.calculateTax(1000000, 0.003), 3000);
    const f = calc({ tradeMode: 'dayTrade', lots: '1', entryPrice: '100', exitPrice: '100.5' });
    const rd = calc({ tradeMode: 'dayTrade', lots: '1', entryPrice: '100', exitPrice: '100.5', taxRounding: 'round' });
    assert.equal(f.manualExit.exitTax, 150);
    assert.equal(rd.manualExit.exitTax, 151);
  });
});

describe('規則：手續費與折數', () => {
  test('[手續費] 即時折讓：max(⌊成交 × 0.1425% × 折⌋, 低消)', () => {
    assert.deepEqual(plain(T.calculateCommission(1000000, { discount: 0.18, minFee: 20, feeModel: 'instant' })), { charged: 256, refund: 0, net: 256 }); // ⌊256.5⌋
    assert.deepEqual(plain(T.calculateCommission(10000, { discount: 0.18, minFee: 20 })), { charged: 20, refund: 0, net: 20 }); // ⌊2.565⌋ < 20
    // F07：800,000 × 0.1425% × 0.35 精確為 399（浮點會得 398）
    assert.equal(T.calculateCommission(800000, { discount: 0.35, minFee: 0 }).net, 399);
    assert.equal(T.calculateCommission(0, { discount: 0.18, minFee: 20 }).net, 0);
  });

  test('[手續費] 月退制：交割收 max(⌊成交 × 0.1425%⌋, 低消)、次月退 ⌊收取 × (1−折)⌋', () => {
    // 1,000,000：收 1,425、退 ⌊1,425 × 0.82⌋ = ⌊1,168.5⌋ = 1,168、淨 257
    assert.deepEqual(plain(T.calculateCommission(1000000, { discount: 0.18, minFee: 20, feeModel: 'monthly' })), { charged: 1425, refund: 1168, net: 257 });
    // 10,000：收 max(14, 20) = 20、退 ⌊16.4⌋ = 16、淨 4
    assert.deepEqual(plain(T.calculateCommission(10000, { discount: 0.18, minFee: 20, feeModel: 'monthly' })), { charged: 20, refund: 16, net: 4 });
  });

  test('[手續費] 月退制端到端：損益用 net、交割用 charged，當沖交割淨額 + 退款 = 淨損益', () => {
    // 10 張 100 → 101 先買後賣：進場 收 1,425 退 1,168；出場 1,010,000 收 ⌊1,439.25⌋ = 1,439 退 ⌊1,179.98⌋ = 1,179；稅 1,515
    // 損益 = 10,000 − 257 − 260 − 1,515 = 7,968；交割淨額 = (1,010,000 − 1,439 − 1,515) − (1,000,000 + 1,425) = 5,621
    const r = calc({ tradeMode: 'dayTrade', lots: '10', entryPrice: '100', exitPrice: '101', feeModel: 'monthly' });
    assert.equal(r.entry.cashOut, 1001425);
    assert.equal(r.entry.capitalBase, 1000257);
    assert.equal(r.manualExit.profit, 7968);
    assert.equal(r.manualExit.settlement.amount, 5621);
    assert.equal(r.manualExit.settlement.amount + r.entry.commission.refund + r.manualExit.exitCommission.refund, r.manualExit.profit);
    assert.equal(r.fee.model, 'monthly');
  });

  test('[折數] parseDiscount', () => {
    const p = (x) => plain(T.parseDiscount(x));
    assert.deepEqual([p('2.8').value, p('2.8').label, p('2.8').adjusted], [0.28, '2.8 折', true]);
    assert.deepEqual([p('0.18').value, p('0.18').label, p('0.18').adjusted], [0.18, '1.8 折', false]);
    assert.deepEqual([p('10').value, p('10').label], [1, '無折扣']);
    assert.deepEqual([p('1').value, p('1').label, p('1').adjusted], [1, '無折扣', false]);
    assert.deepEqual([p('6').value, p('6').label], [0.6, '6 折']);
    assert.deepEqual([p('12').value, p('12').clamped], [1, true]);
    assert.deepEqual([p('-1').value, p('-1').clamped], [0, true]);
    assert.equal(p('２．８折').value, 0.28); // 全形與「折」字
    assert.equal(p(0.285).label, '2.85 折');
    assert.deepEqual([p('').value, p('').defaulted], [0.18, true]);
    assert.deepEqual([p('abc').value, p('abc').invalid], [0.18, true]);
    // 端到端：折數 '2.8' 視為 2.8 折 → 1,000,000 × 0.1425% × 0.28 = 399
    const r = calc({ tradeMode: 'dayTrade', lots: '10', entryPrice: '100', discount: '2.8' });
    assert.equal(r.entry.commission.net, 399);
    assert.equal(r.fee.discountLabel, '2.8 折');
    assert.equal(hasWarn(r, 'DISCOUNT_ADJUSTED'), true);
  });
});

describe('規則：融券保證金最低成數', () => {
  test('[保證金] 依交易日期：2025-04-06=90%、2025-04-07=130%、2025-05-25=130%、2025-05-26=90%、2026-11-08=90%、2026-11-09=130%', () => {
    const cases = [['2025-04-06', 0.9], ['2025-04-07', 1.3], ['2025-05-25', 1.3], ['2025-05-26', 0.9], ['2026-11-08', 0.9], ['2026-11-09', 1.3], ['2030-01-01', 1.3]];
    for (const [d, ratio] of cases) assert.equal(T.getMinShortMarginRatio(d).ratio, ratio, d);
    assert.equal(T.getMinShortMarginRatio('2026-11-09').from, '2026-11-09');
    // 空白＝自動採當日最低值：10 張 100 元、2026-11-09 → 保證金 1,300,000
    const r = calc({ tradeDate: '2026-11-09', tradeMode: 'marginShort', direction: 'short', lots: '10', entryPrice: '100', shortMarginRatio: '' });
    assert.equal(r.entry.collateral, 1300000);
    assert.equal(r.credit.marginRatioAuto, true);
    assert.equal(r.shortMarginMin.ratio, 1.3);
    // 使用者可輸入更高值
    const hi = calc({ tradeDate: '2026-11-09', tradeMode: 'marginShort', direction: 'short', lots: '10', entryPrice: '100', shortMarginRatio: '150' });
    assert.equal(hi.entry.collateral, 1500000);
    assert.equal(hasWarn(hi, 'SHORT_MARGIN_RAISED'), false);
  });
});

describe('規則：升降單位與漲跌停', () => {
  test('[漲跌停] 證交所官方範例：參考價 40.60 → 漲停 44.65、跌停 36.55', () => {
    assert.deepEqual(plain(T.getPriceLimits(40.6, 'stock', 0.1)), { refPrice: 40.6, limitUp: 44.65, limitDown: 36.55, limitPct: 0.1 });
    const r = calc({ tradeMode: 'dayTrade', lots: '1', entryPrice: '40.6', refPrice: '40.60', limitPct: '0.1' });
    assert.deepEqual(plain(r.limits), { refPrice: 40.6, limitUp: 44.65, limitDown: 36.55, limitPct: 0.1 });
  });

  test('[漲跌停] 跨級距依結果價格本身級距：45.6 → 漲停 50.1（50.16 不能取 50.15）', () => {
    const l = T.getPriceLimits(45.6, 'stock', 0.1);
    assert.equal(l.limitUp, 50.1);
    assert.equal(l.limitDown, 41.05); // 41.04 → 進位到 0.05 檔
    assert.equal(T.getPriceLimits(9.55, 'stock', 0.1).limitUp, 10.5); // 10.505 → 10.50
    assert.equal(T.getPriceLimits(10.5, 'stock', 0.1).limitDown, 9.45); // 9.45 屬 0.01 級距
    assert.equal(T.getPriceLimits(45.51, 'etf', 0.1).limitUp, 50.05); // ETF 50.061 → 50.05
  });

  test('[漲跌停] 不足一檔以一檔計', () => {
    // 0.05 × 1.1 = 0.055 → 取 0.05 = 參考價 → 以一檔計 0.06；跌停 0.045 → 0.05 → 一檔 0.04
    assert.deepEqual(plain(T.getPriceLimits(0.05, 'stock', 0.1)), { refPrice: 0.05, limitUp: 0.06, limitDown: 0.04, limitPct: 0.1 });
    assert.deepEqual([T.getPriceLimits(0.15, 'stock', 0.1).limitUp, T.getPriceLimits(0.15, 'stock', 0.1).limitDown], [0.16, 0.14]);
  });

  test('[漲跌停] 最低 0.01', () => {
    const l = T.getPriceLimits(0.01, 'stock', 0.1);
    assert.equal(l.limitDown, 0.01);
    assert.equal(l.limitUp, 0.02);
  });

  test('[漲跌停] 20%（2 倍槓反）與無限制', () => {
    assert.deepEqual([T.getPriceLimits(40.6, 'etf', 0.2).limitUp, T.getPriceLimits(40.6, 'etf', 0.2).limitDown], [48.72, 32.48]);
    assert.equal(T.getPriceLimits(40.6, 'etf', null), null);
    const r = calc({ tradeMode: 'dayTrade', lots: '1', entryPrice: '40.6', refPrice: '40.6', limitPct: 'none' });
    assert.equal(r.limits, null);
  });

  test('[tick] 級距邊界', () => {
    const stock = [[0.01, 0.01], [9.99, 0.01], [10, 0.05], [49.95, 0.05], [50, 0.1], [99.9, 0.1], [100, 0.5], [499.5, 0.5], [500, 1], [999, 1], [1000, 5], [100000, 5]];
    for (const [p, t] of stock) assert.equal(T.getTickSize(p, 'stock'), t, `stock ${p}`);
    const etf = [[0.01, 0.01], [49.99, 0.01], [50, 0.05], [1000, 0.05]];
    for (const [p, t] of etf) {
      assert.equal(T.getTickSize(p, 'etf'), t, `etf ${p}`);
      assert.equal(T.getTickSize(p, 'bondEtf'), t, `bondEtf ${p}`);
    }
    assert.equal(T.getTickSize(0, 'stock'), null);
    assert.equal(T.getTickSize(NaN, 'stock'), null);
  });

  test('[tick] roundToTick / addTick 邊界', () => {
    assert.equal(T.roundToTick(10.03, 'stock', 'nearest'), 10.05);
    assert.equal(T.roundToTick(10.025, 'stock', 'nearest'), 10.05); // 等距取高
    assert.equal(T.roundToTick(10.024, 'stock', 'nearest'), 10);
    assert.equal(T.roundToTick(10.04, 'stock', 'floor'), 10);
    assert.equal(T.roundToTick(10.01, 'stock', 'ceil'), 10.05);
    assert.equal(T.roundToTick(9.995, 'stock', 'ceil'), 10);
    assert.equal(T.roundToTick(50.16, 'stock', 'floor'), 50.1);
    assert.equal(T.roundToTick(0.004, 'stock', 'nearest'), 0.01);
    assert.equal(T.roundToTick(0.005, 'stock', 'floor'), null);
    assert.equal(T.roundToTick(0, 'stock'), null);
    assert.equal(T.roundToTick(-1, 'stock'), null);
    assert.equal(T.roundToTick(0.1 + 0.2, 'stock'), 0.3);
    assert.equal(T.addTick(10, -1, 'stock'), 9.99);
    assert.equal(T.addTick(9.99, 1, 'stock'), 10);
    assert.equal(T.addTick(50, -1, 'stock'), 49.95);
    assert.equal(T.addTick(100, -1, 'stock'), 99.9);
    assert.equal(T.addTick(1000, -1, 'stock'), 999);
    assert.equal(T.addTick(1000, 1, 'stock'), 1005);
    assert.equal(T.addTick(100, 3, 'stock'), 101.5);
    assert.equal(T.addTick(50, -1, 'etf'), 49.99);
    assert.equal(T.addTick(0.01, -1, 'stock'), null);
    assert.equal(T.addTick(0.02, -2, 'stock'), null);
    assert.equal(T.addTick(10.03, 1, 'stock'), 10.05); // 非合法價：往上取下一個合法價
    assert.equal(T.addTick(10.03, -1, 'stock'), 10);
  });

  test('[tick] countTicksBetween：有號、跨級距、>50,000 檔不截斷', () => {
    assert.equal(T.countTicksBetween(10, 9.99, 'stock'), -1);
    assert.equal(T.countTicksBetween(9.99, 10.05, 'stock'), 2);
    assert.equal(T.countTicksBetween(100, 100, 'stock'), 0);
    // ETF：0.01–49.99 共 4,999 檔；50 → 3,000 每檔 0.05 = 59,000 檔 → 63,999
    assert.equal(T.countTicksBetween(0.01, 3000, 'etf'), 63999);
    assert.equal(T.countTicksBetween(3000, 0.01, 'etf'), -63999);
    // ETF 0.01 → 100,000：4,999 + (100,000 − 50) / 0.05 = 2,003,999
    assert.equal(T.countTicksBetween(0.01, 100000, 'etf'), 2003999);
    // 個股 0.01 → 100,000：999 + 800 + 500 + 800 + 500 + (100,000 − 1,000) / 5 = 23,399
    assert.equal(T.countTicksBetween(0.01, 100000, 'stock'), 23399);
  });
});

describe('規則：資券當沖', () => {
  test('[資券當沖] 資買券賣：券賣端收融券手續費、稅 0.3%、不計息、差額交割', () => {
    // G = 1,000,000，進場費 256；出場 101：EG = 1,010,000、費 ⌊259.065⌋ = 259、稅 3,030、融券手續費 round(808) = 808
    // 損益 = 10,000 − 256 − 259 − 3,030 − 808 = 5,647；交割淨額 = (1,010,000 − 259 − 3,030 − 808) − (1,000,000 + 256) = 5,647
    const r = calc({ tradeMode: 'creditDayTrade', direction: 'long', lots: '10', entryPrice: '100', exitPrice: '101' });
    const x = r.manualExit;
    assert.equal(r.tax.rate, 0.003);
    assert.equal(r.entry.shortFee, 0);
    assert.equal(x.exitTax, 3030);
    assert.equal(x.exitShortFee, 808);
    assert.equal(x.interest, 0);
    assert.equal(x.interestType, null);
    assert.equal(x.profit, 5647);
    assert.equal(x.settlement.amount, 5647);
    assert.equal(x.settlement.label, '資券當沖交割淨額');
    assert.equal(r.entry.maintenance, null);
    assert.equal(r.entry.marginCallPrice, null);
    assert.equal(hasWarn(r, 'CREDIT_DAY_TRADE_NOTE'), true);
  });

  test('[資券當沖] 券賣資買：進場收稅與融券手續費、不計息', () => {
    // 進場：費 256、稅 3,000、融券手續費 800；淨收入 995,944；出場 99：EG = 990,000、費 ⌊253.935⌋ = 253
    // 損益 = 10,000 − 256 − 3,000 − 800 − 253 = 5,691
    const r = calc({ tradeMode: 'creditDayTrade', direction: 'short', lots: '10', entryPrice: '100', exitPrice: '99' });
    assert.deepEqual([r.entry.tax, r.entry.shortFee, r.entry.cashIn, r.entry.cashOut, r.entry.capitalBase], [3000, 800, 995944, 0, 995944]);
    assert.equal(r.manualExit.exitTax, 0);
    assert.equal(r.manualExit.exitShortFee, 0);
    assert.equal(r.manualExit.interest, 0);
    assert.equal(r.manualExit.profit, 5691);
    assert.equal(r.manualExit.settlement.amount, 5691);
  });
});

describe('規則：組合驗證與輸入清洗', () => {
  test('[組合] 不合法組合回傳 ok:false（不得硬算）', () => {
    const bad = [
      [{ tradeMode: 'cash', direction: 'short' }, 'INVALID_COMBINATION'],
      [{ tradeMode: 'marginLong', direction: 'short' }, 'INVALID_COMBINATION'],
      [{ tradeMode: 'marginShort', direction: 'long' }, 'INVALID_COMBINATION'],
      [{ tradeMode: 'dayTrade', direction: 'sideways' }, 'INVALID_DIRECTION'],
      [{ tradeMode: 'nonDayTrade', direction: 'long' }, 'INVALID_MODE'],
      [{ tradeMode: 'dayTrade', productType: 'warrant' }, 'INVALID_PRODUCT'],
      [{ tradeMode: 'dayTrade', entryPrice: '' }, 'ENTRY_PRICE_REQUIRED'],
      [{ tradeMode: 'dayTrade', entryPrice: '-5' }, 'ENTRY_PRICE_OUT_OF_RANGE'],
      [{ tradeMode: 'dayTrade', entryPrice: '100001' }, 'ENTRY_PRICE_OUT_OF_RANGE'],
      [{ tradeMode: 'dayTrade', entryPrice: '1e308' }, 'ENTRY_PRICE_OUT_OF_RANGE'],
      [{ tradeMode: 'dayTrade', entryPrice: 'abc' }, 'ENTRY_PRICE_INVALID'],
      [{ tradeMode: 'dayTrade', lots: '0' }, 'LOTS_OUT_OF_RANGE'],
      [{ tradeMode: 'dayTrade', lots: '' }, 'LOTS_REQUIRED'],
    ];
    for (const [over, code] of bad) {
      const r = calc({ direction: 'long', entryPrice: '100', ...over });
      assert.equal(r.ok, false, JSON.stringify(over));
      assert.ok(r.errors.some((e) => e.code === code), `${JSON.stringify(over)} → ${JSON.stringify(r.errors)}`);
      assert.equal(r.breakEven, undefined);
    }
    // 只允許單一方向的模式可省略方向
    assert.equal(calc({ tradeMode: 'marginShort', direction: '', entryPrice: '100' }).direction, 'short');
  });

  test('[清洗] 全形數字、非 tick 價、非整數張數、天數小數與期限提示', () => {
    // 100.03 屬 100–500 級距（0.5）→ 最接近 100.0
    const r = calc({ tradeMode: 'marginLong', entryPrice: '１００．０３', lots: '2.6', marginDays: '2.5' });
    assert.equal(r.entryPrice, 100);
    assert.equal(r.rawEntryPrice, 100.03);
    assert.equal(r.entryPriceAdjusted, true);
    assert.equal(r.entryTick, 0.5);
    assert.equal(r.lots, 3);
    assert.equal(r.shares, 3000);
    assert.equal(r.inputs.marginDays, 3);
    assert.ok(['ENTRY_ADJUSTED', 'NON_INTEGER_LOTS', 'DAYS_ROUNDED'].every((c) => hasWarn(r, c)), codes(r).join());
    const r2 = calc({ tradeMode: 'marginLong', entryPrice: '100', lots: '1,000', marginDays: '200' });
    assert.equal(r2.lots, 1000);
    assert.equal(hasWarn(r2, 'DAYS_OVER_180'), true);
    // 出場價非 tick → 調整並警示
    const r3 = calc({ tradeMode: 'dayTrade', entryPrice: '100', exitPrice: '100.3' });
    assert.equal(r3.manualExit.exitPrice, 100.5);
    assert.equal(hasWarn(r3, 'EXIT_ADJUSTED'), true);
    // 超出漲跌停
    const r4 = calc({ tradeMode: 'dayTrade', entryPrice: '100', refPrice: '100', exitPrice: '111' });
    assert.equal(r4.limits.limitUp, 110);
    assert.equal(r4.manualExit.beyondLimit, true);
    assert.equal(hasWarn(r4, 'EXIT_BEYOND_LIMIT'), true);
    // 與模式無關的欄位不發警示（現股當沖時融資自備 5% 不提示）
    const r5 = calc({ tradeMode: 'dayTrade', entryPrice: '100', marginSelfRatio: '5', shortMarginRatio: '10' });
    assert.equal(hasWarn(r5, 'SELF_RATIO_CLAMPED'), false);
    assert.equal(hasWarn(r5, 'SHORT_MARGIN_RAISED'), false);
    // 天數負數 → 0 並警示
    const r6 = calc({ tradeMode: 'marginLong', entryPrice: '100', marginDays: '-5' });
    assert.equal(r6.inputs.marginDays, 0);
    assert.equal(hasWarn(r6, 'INPUT_CLAMPED'), true);
  });

  test('[目標價] 最多 12 列、desiredProfit = round(capitalBase × rate)、做空不可達 reachable:false', () => {
    const r = calc({ tradeMode: 'dayTrade', lots: '10', entryPrice: '100' });
    assert.equal(r.targets.length, 7);
    const cb = r.entry.capitalBase; // 1,000,000 + 256
    assert.equal(cb, 1000256);
    assert.equal(r.targets[0].desiredProfit, 30008); // round(1,000,256 × 3%) = round(30,007.68)
    assert.equal(r.targets[1].desiredProfit, 25006); // round(25,006.4)
    for (const t of r.targets) {
      assert.ok(t.profit >= t.desiredProfit);
      assert.equal(t.reachable, true);
    }
    const many = calc({ tradeMode: 'dayTrade', entryPrice: '100', targets: '1,2,3,4,5,6,7,8,9,10,11,12,13' });
    assert.equal(many.targets.length, 12);
    assert.equal(hasWarn(many, 'TARGETS_TRUNCATED'), true);
    const mixed = calc({ tradeMode: 'dayTrade', entryPrice: '100', targets: '−3、3, abc' });
    assert.deepEqual(plain(mixed.targets.map((t) => t.targetPct)), [-3, 3]);
    assert.equal(hasWarn(mixed, 'TARGETS_INVALID'), true);
    // F11：做空 100% 目標 → 跌到 0.01 也只賺 998,124 < 998,244 → 不可達
    const s = calc({ tradeMode: 'dayTrade', direction: 'short', lots: '10', entryPrice: '100', targets: '100' });
    assert.equal(s.entry.capitalBase, 998244);
    assert.equal(s.targets[0].reachable, false);
    assert.equal(s.targets[0].exitPrice, 0.01);
    assert.equal(s.targets[0].profit, 998124);
    // F11：做多停損 2,000,000 大於最大可能虧損（0.01 時 −1,000,176）→ 不可達
    const l = calc({ tradeMode: 'dayTrade', lots: '10', entryPrice: '100', stopLoss: '2000000' });
    assert.equal(l.stopLoss.reachable, false);
    assert.equal(l.stopLoss.profit, -1000176);
    assert.equal(hasWarn(l, 'STOP_LOSS_UNREACHABLE'), true);
    // 停損：負數取絕對值；desired = −|SL|
    const sl = calc({ tradeMode: 'dayTrade', lots: '10', entryPrice: '100', stopLoss: '-5000' });
    assert.equal(sl.stopLoss.desiredProfit, -5000);
    assert.ok(sl.stopLoss.profit >= -5000);
    const below = calc({ tradeMode: 'dayTrade', lots: '10', entryPrice: '100', exitPrice: String(T.addTick(sl.stopLoss.exitPrice, -1, 'stock')) });
    assert.ok(below.manualExit.profit < -5000);
  });

  test('[兩平] 做空費用高於最大可能獲利 → 兩平不可達；本金 ≤ 0 時不產生目標列', () => {
    // 先賣後買 1 張 0.01：G = 10、費 20（低消）、稅 0 → 淨收入 −10；0.01 回補：損益 = 10 − 10 − 20 − 20 = −40
    const r = calc({ tradeMode: 'dayTrade', direction: 'short', lots: '1', entryPrice: '0.01' });
    assert.equal(r.entry.capitalBase, -10);
    assert.equal(r.breakEven.reachable, false);
    assert.equal(r.breakEven.exitPrice, 0.01);
    assert.equal(r.breakEven.profit, -40);
    assert.equal(r.breakEven.returnRate, null);
    assert.equal(r.targets.length, 0);
    assert.ok(hasWarn(r, 'BREAKEVEN_UNREACHABLE') && hasWarn(r, 'CAPITAL_BASE_NONPOSITIVE'));
    // 零成本（債券ETF 停徵、折數 0、低消 0）時兩平＝進場價
    const z = calc({ tradeMode: 'cash', productType: 'bondEtf', lots: '1', entryPrice: '0.01', discount: '0', minFee: '0' });
    assert.equal(z.breakEven.exitPrice, 0.01);
    assert.equal(z.breakEven.profit, 0);
    assert.equal(z.breakEven.reachable, true);
  });

  test('[邊界] 最大價格 × 最大張數：所有金額為安全整數；超出搜尋範圍的目標 reachable:false', () => {
    const moneyKeys = ['gross', 'tax', 'shortFee', 'loan', 'selfFunds', 'collateral', 'guaranty', 'cashOut', 'cashIn', 'capitalBase', 'interest',
      'exitGross', 'exitTax', 'exitShortFee', 'totalCosts', 'profit', 'desiredProfit', 'charged', 'refund', 'net', 'amount'];
    const walk = (o, where) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (moneyKeys.includes(k) && typeof v === 'number') assert.ok(Number.isSafeInteger(v), `${where}.${k} = ${v}`);
        if (v && typeof v === 'object' && k !== 'mode' && k !== 'product' && k !== 'inputs') walk(v, `${where}.${k}`);
      }
    };
    for (const [tradeMode, direction] of [['dayTrade', 'long'], ['dayTrade', 'short'], ['cash', 'long'], ['marginLong', 'long'], ['marginShort', 'short'], ['creditDayTrade', 'long'], ['creditDayTrade', 'short']]) {
      for (const productType of ['stock', 'etf']) {
        const r = calc({ tradeMode, direction, productType, lots: '100000', entryPrice: '100000', exitPrice: '0.01', stopLoss: '1000000000000000', targets: '1000, -1000, 999.99, -99.99, 0.000001', shortMarginRatio: '1000', marginInterestRate: '100', shortInterestRate: '100', marginDays: '99999', shortDays: '99999' });
        assert.equal(r.ok, true);
        walk(r, `${tradeMode}/${direction}/${productType}`);
        for (const tg of r.targets) if (tg.reachable) assert.ok(tg.profit >= tg.desiredProfit);
        // 先賣後買最大獲利 ≈ 成交金額，1000% 目標不可達（融券另含利息收入，不在此斷言）
        if (tradeMode === 'dayTrade' && direction === 'short') assert.equal(r.targets[0].reachable, false);
      }
    }
    const over = calc({ tradeMode: 'dayTrade', entryPrice: '100', targets: '1001, -1001, 5' });
    assert.deepEqual(plain(over.targets.map((t) => t.targetPct)), [5]);
    assert.equal(hasWarn(over, 'TARGETS_INVALID'), true);
  });

  test('[格式] -0 顯示為 0、percent 固定 2 位小數', () => {
    assert.equal(T.format.currency(-0), '0');
    assert.equal(T.format.signedCurrency(-0), '0');
    assert.equal(T.format.signedCurrency(-0.4), '0');
    assert.equal(T.format.signedCurrency(1234), '+1,234');
    assert.equal(T.format.signedCurrency(-1234567), '-1,234,567');
    assert.equal(T.format.percent(0.0305), '3.05%');
    assert.equal(T.format.percent(0.1), '10.00%');
    assert.equal(T.format.percent(-0), '0.00%');
    assert.equal(T.format.percent(-0.00001), '0.00%');
    assert.equal(T.format.percent(0.0305, { signed: true }), '+3.05%');
    assert.equal(T.format.price(43.55), '43.55');
    assert.equal(T.format.price(1005), '1,005.00');
    assert.equal(T.format.ratio(0.0645), '6.45%');
    assert.equal(T.format.ratio(0.001425), '0.1425%');
    assert.equal(T.format.ratio(1.3), '130%');
    assert.equal(T.format.price(null), '--');
  });

  test('[API] 版本、預設值、台北日期', () => {
    assert.equal(T.VERSION, '2.0.0');
    const d = T.getDefaults();
    assert.equal(d.tradeMode, 'marginLong');
    assert.equal(d.marginInterestRate, '6.45');
    assert.equal(d.shortMarginRatio, '');
    assert.equal(d.shortInterestRate, '0.2');
    assert.equal(d.targets, '3, 2.5, 2, 1, 0, -1, -2');
    assert.deepEqual(plain(T.MODES.dayTrade.directions), ['long', 'short']);
    assert.deepEqual(plain(T.MODES.cash.directions), ['long']);
    assert.equal(T.PRODUCTS.bondEtf.tickTable, 'etf');
    // 2026-11-05 16:00 UTC = 2026-11-06 00:00 台北
    assert.equal(T.todayTaipei(Date.UTC(2026, 10, 5, 16, 0, 0)), '2026-11-06');
    assert.equal(T.todayTaipei(Date.UTC(2026, 10, 5, 15, 59, 59)), '2026-11-05');
    assert.match(T.todayTaipei(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ════════════════════════════════════════════════════════════════════
// 三、價格階梯
// ════════════════════════════════════════════════════════════════════
describe('價格階梯', () => {
  test('[階梯] 數量、由高到低排序、isEntry／isBreakEven 標記、ticks 累加', () => {
    const r = calc({ tradeMode: 'dayTrade', lots: '3', entryPrice: '43.45', discount: '0.28' });
    const { rows } = T.buildLadder(r, { up: 10, down: 10 });
    assert.equal(rows.length, 21);
    for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i - 1].exitPrice > rows[i].exitPrice);
    assert.deepEqual(plain(rows.map((x) => x.ticks)), Array.from({ length: 21 }, (_, i) => 10 - i));
    assert.equal(rows.filter((x) => x.isEntry).length, 1);
    assert.equal(rows[10].isEntry, true);
    assert.equal(rows[10].exitPrice, 43.45);
    const be = rows.filter((x) => x.isBreakEven);
    assert.equal(be.length, 1);
    assert.equal(be[0].exitPrice, 43.55);
    assert.equal(rows.indexOf(be[0]), 8);
    // 與 calculate 的單點結果一致
    const one = calc({ tradeMode: 'dayTrade', lots: '3', entryPrice: '43.45', discount: '0.28', exitPrice: String(rows[3].exitPrice) });
    assert.deepEqual(plain({ ...rows[3], isEntry: undefined, isBreakEven: undefined, isLimitUp: undefined, isLimitDown: undefined, isMarginCall: undefined }), plain(one.manualExit));
  });

  test('[階梯] 跌到 0.01 停止', () => {
    const r = calc({ tradeMode: 'dayTrade', productType: 'etf', lots: '1', entryPrice: '0.05' });
    const { rows } = T.buildLadder(r, { up: 2, down: 10 });
    assert.deepEqual(plain(rows.map((x) => x.exitPrice)), [0.07, 0.06, 0.05, 0.04, 0.03, 0.02, 0.01]);
  });

  test('[階梯] 漲跌停與追繳價標記、超出者 beyondLimit', () => {
    // 參考價 100：漲停 110（+20 檔，每檔 0.5）、跌停 90（−100 檔，每檔 0.1）
    const r = calc({ tradeMode: 'dayTrade', lots: '1', entryPrice: '100', refPrice: '100' });
    const { rows } = T.buildLadder(r, { up: 22, down: 102 });
    const up = rows.filter((x) => x.isLimitUp);
    const dn = rows.filter((x) => x.isLimitDown);
    assert.equal(up.length, 1);
    assert.equal(up[0].exitPrice, 110);
    assert.equal(up[0].ticks, 20);
    assert.equal(dn.length, 1);
    assert.equal(dn[0].exitPrice, 90);
    assert.equal(dn[0].ticks, -100);
    assert.equal(rows.filter((x) => x.beyondLimit).length, 4);
    // F01 融資：追繳價 58.5 位於進場 100 下方 415 檔（100 → 99.9 為 1 檔，99.9 → 58.5 為 414 檔）
    const m = calc({ tradeMode: 'marginLong', lots: '2', entryPrice: '100', marginSelfRatio: '55' });
    const lad = T.buildLadder(m, { up: 0, down: 420 }).rows;
    const call = lad.filter((x) => x.isMarginCall);
    assert.equal(call.length, 1);
    assert.equal(call[0].exitPrice, 58.5);
    assert.equal(call[0].ticks, -415);
    assert.equal(call[0].belowCall, false);
    assert.equal(lad[lad.indexOf(call[0]) + 1].belowCall, true);
  });

  test('[階梯] 不合法結果回傳空列；結果物件被複製後仍可重建', () => {
    assert.deepEqual(plain(T.buildLadder({ ok: false }, { up: 5, down: 5 })), { rows: [] });
    const r = calc({ tradeMode: 'marginShort', direction: 'short', lots: '5', entryPrice: '250' });
    const cloned = JSON.parse(JSON.stringify(r));
    assert.deepEqual(plain(T.buildLadder(cloned, { up: 3, down: 3 })), plain(T.buildLadder(r, { up: 3, down: 3 })));
  });

  test('[階梯] 效能：±2000 檔 < 300ms', (t) => {
    const r = calc({ tradeMode: 'marginLong', lots: '10', entryPrice: '100', exitPrice: '103', stopLoss: '5000', refPrice: '100' });
    const t0 = performance.now();
    const first = T.buildLadder(r, { up: 2000, down: 2000 });
    const cold = performance.now() - t0;
    let best = cold;
    for (let i = 0; i < 3; i += 1) {
      const s = performance.now();
      T.buildLadder(r, { up: 2000, down: 2000 });
      best = Math.min(best, performance.now() - s);
    }
    t.diagnostic(`buildLadder ±2000：首次 ${cold.toFixed(1)} ms，最佳 ${best.toFixed(1)} ms`);
    assert.equal(first.rows.length, 4001);
    assert.ok(cold < 300, `首次 ${cold} ms`);
    assert.ok(best < 300, `最佳 ${best} ms`);
  });

  test('[效能] 典型 calculate() < 5ms', (t) => {
    const scenarios = [
      { tradeMode: 'dayTrade', direction: 'long', lots: '10', entryPrice: '100', exitPrice: '101', stopLoss: '5000', refPrice: '100' },
      { tradeMode: 'dayTrade', direction: 'short', lots: '10', entryPrice: '100', exitPrice: '99', stopLoss: '5000' },
      { tradeMode: 'cash', direction: 'long', lots: '10', entryPrice: '588', exitPrice: '600', stopLoss: '20000' },
      { tradeMode: 'marginLong', direction: 'long', lots: '10', entryPrice: '100', exitPrice: '103', stopLoss: '5000' },
      { tradeMode: 'marginShort', direction: 'short', lots: '10', entryPrice: '100', exitPrice: '95', stopLoss: '5000' },
      { tradeMode: 'creditDayTrade', direction: 'long', lots: '10', entryPrice: '100', exitPrice: '101', stopLoss: '5000' },
      { tradeMode: 'creditDayTrade', direction: 'short', productType: 'etf', lots: '10', entryPrice: '45.3', exitPrice: '45', stopLoss: '5000' },
    ];
    for (const s of scenarios) for (let i = 0; i < 30; i += 1) calc(s); // 暖機
    const N = 100;
    let worst = 0;
    for (const s of scenarios) {
      const t0 = performance.now();
      for (let i = 0; i < N; i += 1) calc(s);
      const avg = (performance.now() - t0) / N;
      worst = Math.max(worst, avg);
      t.diagnostic(`${s.tradeMode}/${s.direction}：平均 ${avg.toFixed(3)} ms`);
    }
    assert.ok(worst < 5, `最慢平均 ${worst} ms`);
  });
});

// ════════════════════════════════════════════════════════════════════
// 三之二、v2 修正清單（FIXES.md A：E1–E8）
// ════════════════════════════════════════════════════════════════════
const warnOf = (r, code) => r.warnings.find((w) => w.code === code);

describe('修正 E1：維持率向下截斷到 0.01%，顯示與追繳判斷一致', () => {
  test('[E1] 融資 777 × 6 張自備 40%、2026-11-09：出場 606 → 129.99% 且 belowCall；出場 607（追繳價）→ 130.21% 不追繳', () => {
    // G = 777 × 6,000 = 4,662,000；loan = ⌊4,662,000 × 60% / 1000⌋ × 1000 = ⌊2,797.2⌋ × 1000 = 2,797,000
    // 606：EG = 3,636,000；⌊3,636,000 × 10000 / 2,797,000⌋ = ⌊12,999.64⌋ → 129.99%；3,636,000 × 100 = 363,600,000 < 130 × 2,797,000 = 363,610,000 → 追繳
    // 追繳價 = ceil_tick(130 × 2,797,000 / 6,000 = 60,601.67 分 = 606.02 元) → 607；607：⌊3,642,000 × 10000 / 2,797,000⌋ = ⌊13,021.09⌋ → 130.21%
    // 進場：⌊4,662,000 × 10000 / 2,797,000⌋ = ⌊16,667.86⌋ → 166.67%
    const base = { tradeDate: '2026-11-09', tradeMode: 'marginLong', direction: 'long', lots: '6', entryPrice: '777', marginSelfRatio: '40' };
    const r = calc({ ...base, exitPrice: '606' });
    assert.equal(r.entry.loan, 2797000);
    assert.equal(r.entry.maintenance, 166.67);
    assert.equal(r.entry.marginCallPrice, 607);
    assert.equal(r.manualExit.exitGross, 3636000);
    assert.equal(r.manualExit.maintenance, 129.99);
    assert.equal(r.manualExit.belowCall, true);
    assert.equal(T.format.maintenance(r.manualExit.maintenance), '129.99%');
    assert.equal(hasWarn(r, 'EXIT_BELOW_CALL'), true);
    const c = calc({ ...base, exitPrice: '607' });
    assert.equal(c.manualExit.maintenance, 130.21);
    assert.equal(c.manualExit.belowCall, false);
    assert.equal(hasWarn(c, 'EXIT_BELOW_CALL'), false);
  });

  test('[E1] 出場恰為追繳價且維持率恰 130%：顯示 130.00%、不追繳（F08 ETF 53.6 × 10 張 → 41.73）；下一檔 41.72 → 129.96% 追繳', () => {
    // loan = 321,000；41.73：417,300 × 10000 / 321,000 = 13,000 → 130.00%；41.72：⌊417,200 × 10000 / 321,000⌋ = ⌊12,996.88⌋ → 129.96%
    const base = { tradeMode: 'marginLong', direction: 'long', productType: 'etf', lots: '10', entryPrice: '53.6', marginSelfRatio: '40', marginDays: '0' };
    const at = calc({ ...base, exitPrice: '41.73' });
    assert.equal(at.entry.marginCallPrice, 41.73);
    assert.equal(at.manualExit.maintenance, 130);
    assert.equal(at.manualExit.belowCall, false);
    assert.equal(T.format.maintenance(at.manualExit.maintenance), '130.00%');
    const below = calc({ ...base, exitPrice: '41.72' });
    assert.equal(below.manualExit.maintenance, 129.96);
    assert.equal(below.manualExit.belowCall, true);
  });

  test('[E1] 融券 37.8 × 1 張（2026-11-09 自動 130%）出場 66.8 → 129.99% 且 belowCall；1005 → 1775 同理', () => {
    // G = 37,800；費 max(⌊37,800 × 0.1425% × 0.18⌋ = 9, 20) = 20；稅 ⌊113.4⌋ = 113；融券手續費 round(30.24) = 30
    // 保證金 ⌈37,800 × 130% / 100⌉ × 100 = ⌈491.4⌉ × 100 = 49,200；擔保價款 37,800 − 20 − 113 − 30 = 37,637；合計 86,837
    // 66.8：⌊86,837 × 10000 / 66,800⌋ = ⌊12,999.55⌋ → 129.99%；86,837 × 100 = 8,683,700 < 130 × 66,800 = 8,684,000 → 追繳
    // 追繳價 66.7：⌊86,837 × 10000 / 66,700⌋ = ⌊13,019.04⌋ → 130.19%
    const base = { tradeDate: '2026-11-09', tradeMode: 'marginShort', direction: 'short', lots: '1', entryPrice: '37.8', shortMarginRatio: '' };
    const r = calc({ ...base, exitPrice: '66.8' });
    assert.deepEqual([r.entry.collateral, r.entry.guaranty], [49200, 37637]);
    assert.equal(r.manualExit.maintenance, 129.99);
    assert.ok(r.manualExit.maintenance <= 129.99);
    assert.equal(r.manualExit.belowCall, true);
    assert.equal(T.format.maintenance(r.manualExit.maintenance), '129.99%');
    assert.equal(r.entry.marginCallPrice, 66.7);
    const c = calc({ ...base, exitPrice: '66.7' });
    assert.equal(c.manualExit.maintenance, 130.19);
    assert.equal(c.manualExit.belowCall, false);
    // 1005 × 1 張：費 ⌊257.78⌋ = 257、稅 3,015、融券手續費 round(804) = 804；保證金 ⌈13,065⌉ × 100 = 1,306,500；擔保價款 1,000,924
    // 1775：⌊2,307,424 × 10000 / 1,775,000⌋ = ⌊12,999.57⌋ → 129.99%
    const h = calc({ ...base, entryPrice: '1005', exitPrice: '1775' });
    assert.equal(h.entry.collateral + h.entry.guaranty, 2307424);
    assert.equal(h.manualExit.maintenance, 129.99);
    assert.equal(h.manualExit.belowCall, true);
  });

  test('[E1] format.maintenance 不進位（向下截斷到 0.01%）', () => {
    assert.equal(T.format.maintenance(129.9964247407937), '129.99%');
    assert.equal(T.format.maintenance(129.995), '129.99%');
    assert.equal(T.format.maintenance(130), '130.00%');
    assert.equal(T.format.maintenance(166.666666), '166.66%');
    assert.equal(T.format.maintenance(222.22), '222.22%');
    assert.equal(T.format.maintenance(null), '--');
  });

  test('[E1] 掃描：融資自備 40%（16 種進場價 × 1–30 張）追繳價下一檔一律顯示 ≤129.99% 且 belowCall；追繳價本身 ≥130.00% 且不追繳', () => {
    const prices = ['9.99', '12.35', '18.8', '23.45', '37.6', '49.95', '53.4', '77.7', '99.9', '128.5', '256', '499.5', '606', '777', '999', '1235'];
    let n = 0;
    for (const p of prices) {
      for (let lots = 1; lots <= 30; lots += 1) {
        const base = { tradeDate: '2026-11-09', tradeMode: 'marginLong', direction: 'long', lots: String(lots), entryPrice: p, marginSelfRatio: '40', targets: '' };
        const r0 = calc(base);
        if (r0.entry.marginCallPrice == null) continue;
        const call = r0.entry.marginCallPrice;
        const at = calc({ ...base, exitPrice: String(call) }).manualExit;
        assert.equal(at.belowCall, false, `${p}×${lots} @${call}`);
        assert.ok(at.maintenance >= 130 && Number.parseFloat(T.format.maintenance(at.maintenance)) >= 130, `${p}×${lots} @${call} ${at.maintenance}`);
        const prev = T.addTick(call, -1, 'stock');
        if (prev == null) continue;
        const bl = calc({ ...base, exitPrice: String(prev) }).manualExit;
        assert.equal(bl.belowCall, true, `${p}×${lots} @${prev}`);
        assert.ok(bl.maintenance <= 129.99 && Number.parseFloat(T.format.maintenance(bl.maintenance)) <= 129.99, `${p}×${lots} @${prev} ${bl.maintenance} ${T.format.maintenance(bl.maintenance)}`);
        n += 1;
      }
    }
    assert.ok(n > 400, `掃描 ${n} 例`);
  });

  test('[E1] 階梯每列：belowCall ⇔ 維持率 < 130', () => {
    for (const s of [
      { tradeMode: 'marginLong', direction: 'long', lots: '6', entryPrice: '777', marginSelfRatio: '40' },
      { tradeMode: 'marginShort', direction: 'short', lots: '1', entryPrice: '37.8', shortMarginRatio: '' },
    ]) {
      const r = calc({ ...s, tradeDate: '2026-11-09' });
      const rows = T.buildLadder(r, { up: 600, down: 400 }).rows;
      for (const row of rows) assert.equal(row.belowCall, row.maintenance < 130, `${s.tradeMode} @${row.exitPrice} ${row.maintenance}`);
      assert.ok(rows.some((x) => x.belowCall) && rows.some((x) => !x.belowCall));
    }
  });
});

describe('修正 E2：債券ETF 停徵起日 2017-01-01', () => {
  test('[E2] 2016-12-31 為 0.1%（停徵尚未施行）；2017-01-01、2026-12-31 為 0；2027-01-01 為 0.1% 並警示', () => {
    const at = (d) => T.resolveTaxRate({ productType: 'bondEtf', tradeMode: 'cash', tradeDate: d });
    const a = at('2016-12-31');
    assert.equal(a.rate, 0.001);
    assert.equal(a.label, '債券ETF 0.1%（停徵尚未施行）');
    assert.equal(at('2017-01-01').rate, 0);
    assert.equal(at('2017-01-01').label, '債券ETF 停徵 0%');
    assert.equal(at('2026-12-31').rate, 0);
    const d = at('2027-01-01');
    assert.equal(d.rate, 0.001);
    assert.ok(d.warnings.some((w) => w.code === 'BOND_ETF_EXEMPTION_ENDED'));
    // 端到端：現股 10 張 45 元 → 出場稅 ⌊450,000 × 0.1%⌋ = 450（2016-12-31）、0（2017-01-01）
    const r1 = calc({ tradeDate: '2016-12-31', tradeMode: 'cash', productType: 'bondEtf', lots: '10', entryPrice: '45', exitPrice: '45' });
    const r2 = calc({ tradeDate: '2017-01-01', tradeMode: 'cash', productType: 'bondEtf', lots: '10', entryPrice: '45', exitPrice: '45' });
    assert.equal(r1.manualExit.exitTax, 450);
    assert.equal(r1.tax.label, '債券ETF 0.1%（停徵尚未施行）');
    assert.equal(r2.manualExit.exitTax, 0);
  });
});

describe('修正 E3：getPriceLimits 穩健性', () => {
  test('[E3] 參考價無法解析、≤0、> 100,000 回傳 null，任何輸入都不拋例外', () => {
    for (const x of [1e11, 1e10, 10000000001, 100000.01, -1, 0, 'abc', null, undefined, '', '1e309', Number.MAX_VALUE, 12345678901234567890n, {}, [], NaN, Infinity]) {
      let v;
      assert.doesNotThrow(() => { v = T.getPriceLimits(x, 'stock', 0.1); }, String(x));
      assert.equal(v, null, String(x));
      assert.doesNotThrow(() => T.getPriceLimits(x, 'etf', 0.2));
    }
    // 上限本身仍可計算：100,000 → 漲停 110,000、跌停 90,000（≥1000 元級距每檔 5 元）
    assert.deepEqual(plain(T.getPriceLimits(100000, 'stock', 0.1)), { refPrice: 100000, limitUp: 110000, limitDown: 90000, limitPct: 0.1 });
    assert.deepEqual(plain(T.getPriceLimits('40.60', 'stock', '0.1')), { refPrice: 40.6, limitUp: 44.65, limitDown: 36.55, limitPct: 0.1 });
    assert.doesNotThrow(() => T.getPriceLimits(40.6, { evil: true }, { x: 1 }));
    assert.equal(T.getPriceLimits(40.6, 'warrant', 0.1), null);
  });
});

describe('修正 E4：融券保證金成數（空白＝依日期最低；明確輸入只夾到 90%）', () => {
  const ms = (over) => calc({ tradeMode: 'marginShort', direction: 'short', lots: '3', entryPrice: '10.3', ...over });
  test('[E4] < 90% 夾到 90% 並警示；介於 90%–130% 照輸入並發 SHORT_MARGIN_BELOW_MIN；≥ 130% 不警示', () => {
    // G = 30,900；90% → ⌈278.1⌉ × 100 = 27,900；100% → 30,900；129.99% → ⌈401.6691⌉ × 100 = 40,200；130% → 40,200
    const a = ms({ tradeDate: '2026-11-09', shortMarginRatio: '80' });
    assert.equal(a.entry.collateral, 27900);
    assert.equal(a.credit.marginRatio, 0.9);
    assert.ok(hasWarn(a, 'SHORT_MARGIN_RAISED') && hasWarn(a, 'SHORT_MARGIN_BELOW_MIN'));
    assert.match(warnOf(a, 'SHORT_MARGIN_RAISED').message, /80% 低於法定最低 90%，已以 90% 計算/);
    const b = ms({ tradeDate: '2026-11-06', shortMarginRatio: '80' }); // 常態期間：只夾值
    assert.equal(b.entry.collateral, 27900);
    assert.ok(hasWarn(b, 'SHORT_MARGIN_RAISED') && !hasWarn(b, 'SHORT_MARGIN_BELOW_MIN'));
    const c = ms({ tradeDate: '2026-11-09', shortMarginRatio: '129.99' });
    assert.equal(c.credit.marginRatio, 1.2999);
    assert.equal(c.entry.collateral, 40200);
    assert.ok(!hasWarn(c, 'SHORT_MARGIN_RAISED') && hasWarn(c, 'SHORT_MARGIN_BELOW_MIN'));
    const d = ms({ tradeDate: '2026-11-09', shortMarginRatio: '130' });
    assert.equal(d.entry.collateral, 40200);
    assert.ok(!hasWarn(d, 'SHORT_MARGIN_RAISED') && !hasWarn(d, 'SHORT_MARGIN_BELOW_MIN'));
    const e = ms({ tradeDate: '2026-11-06', shortMarginRatio: '100' }); // 常態期間 100% 無警示
    assert.ok(!hasWarn(e, 'SHORT_MARGIN_RAISED') && !hasWarn(e, 'SHORT_MARGIN_BELOW_MIN'));
    // 2025-04-07～05-25 臨時措施期間同理，訊息帶該期起日
    const f = ms({ tradeDate: '2025-04-10', shortMarginRatio: '100' });
    assert.equal(f.entry.collateral, 30900);
    assert.match(warnOf(f, 'SHORT_MARGIN_BELOW_MIN').message, /低於 2025-04-07 起的最低融券保證金成數 130%/);
    // 只對融券模式發出
    assert.equal(hasWarn(calc({ tradeMode: 'dayTrade', entryPrice: '100', tradeDate: '2026-11-09', shortMarginRatio: '100' }), 'SHORT_MARGIN_BELOW_MIN'), false);
  });
});

describe('修正 E5：融資出場稅依出場日判斷', () => {
  const ml = (over) => calc({ tradeMode: 'marginLong', direction: 'long', productType: 'bondEtf', lots: '10', entryPrice: '30', exitPrice: '30', ...over });
  test('[E5] 債券ETF 融資 2026-12-01 ＋ 60 天 → 出場日 2027-01-30，出場稅 0.1% 並警示 TAX_RULE_CHANGES_BEFORE_EXIT', () => {
    // 出場稅 = ⌊300,000 × 0.1%⌋ = 300
    const r = ml({ tradeDate: '2026-12-01', marginDays: '60' });
    assert.equal(r.manualExit.exitTax, 300);
    assert.equal(r.tax.rate, 0.001);
    assert.equal(r.tax.date, '2027-01-30');
    assert.equal(r.tax.basis, 'exit');
    assert.equal(r.tradeDate, '2026-12-01');
    const w = warnOf(r, 'TAX_RULE_CHANGES_BEFORE_EXIT');
    assert.equal(w.level, 'warn');
    assert.equal(w.field, 'marginDays');
    assert.match(w.message, /融資賣出日約 2027-01-30，已超過債券ETF 停徵期限 2026-12-31，出場證交稅以 0\.1% 計/);
    assert.equal(hasWarn(r, 'BOND_ETF_EXEMPTION_ENDED'), false); // 由上一則說明，不重複
    // 兩平需涵蓋出場稅：0 稅時兩平價較低
    assert.ok(r.breakEven.exitTax > 0);
  });

  test('[E5] 天數 10 → 出場日 2026-12-11 仍在停徵期間：出場稅 0、無警示；天數 0 → 出場日＝交易日', () => {
    const r = ml({ tradeDate: '2026-12-01', marginDays: '10' });
    assert.equal(r.manualExit.exitTax, 0);
    assert.equal(r.tax.date, '2026-12-11');
    assert.equal(r.tax.basis, 'exit');
    assert.equal(hasWarn(r, 'TAX_RULE_CHANGES_BEFORE_EXIT'), false);
    const z = ml({ tradeDate: '2026-12-01', marginDays: '0' });
    assert.equal(z.tax.date, '2026-12-01');
  });

  test('[E5] 交易日在停徵前、出場日進入停徵期間 → 0% 並警示；覆寫稅率時不警示；個股不受影響', () => {
    const r = ml({ tradeDate: '2016-12-20', marginDays: '30' }); // 出場日 2017-01-19
    assert.equal(r.tax.date, '2017-01-19');
    assert.equal(r.manualExit.exitTax, 0);
    assert.match(warnOf(r, 'TAX_RULE_CHANGES_BEFORE_EXIT').message, /2017-01-19，已進入債券ETF 停徵期間/);
    const ov = ml({ tradeDate: '2026-12-01', marginDays: '60', taxRateOverride: '0' });
    assert.equal(ov.manualExit.exitTax, 0);
    assert.equal(hasWarn(ov, 'TAX_RULE_CHANGES_BEFORE_EXIT'), false);
    const st = calc({ tradeMode: 'marginLong', direction: 'long', lots: '10', entryPrice: '100', exitPrice: '100', tradeDate: '2027-12-20', marginDays: '60' });
    assert.equal(st.tax.rate, 0.003);
    assert.equal(st.manualExit.exitTax, 3000);
    assert.equal(st.tax.date, '2028-02-18');
    assert.equal(hasWarn(st, 'TAX_RULE_CHANGES_BEFORE_EXIT'), false);
  });

  test('[E5] 融券、資券當沖、現股當沖、現股的稅依交易日期（basis trade）', () => {
    const s = calc({ tradeMode: 'marginShort', direction: 'short', productType: 'bondEtf', lots: '10', entryPrice: '30', tradeDate: '2026-12-31', shortDays: '60' });
    assert.equal(s.tax.basis, 'trade');
    assert.equal(s.tax.date, '2026-12-31');
    assert.equal(s.entry.tax, 0);
    for (const [tradeMode, direction] of [['creditDayTrade', 'short'], ['dayTrade', 'long'], ['cash', 'long']]) {
      const r = calc({ tradeMode, direction, productType: 'bondEtf', lots: '10', entryPrice: '30', tradeDate: '2026-12-31', marginDays: '60' });
      assert.equal(r.tax.basis, 'trade', tradeMode);
      assert.equal(r.tax.rate, 0, tradeMode);
      assert.equal(hasWarn(r, 'TAX_RULE_CHANGES_BEFORE_EXIT'), false, tradeMode);
    }
  });

  test('[E5] 現股債券ETF 距停徵到期 ≤ 90 天 → info BOND_ETF_EXEMPTION_EXPIRING', () => {
    const at = (d, over) => calc({ tradeMode: 'cash', productType: 'bondEtf', lots: '10', entryPrice: '30', tradeDate: d, ...over });
    for (const d of ['2026-10-02', '2026-11-06', '2026-12-31']) {
      const w = warnOf(at(d), 'BOND_ETF_EXEMPTION_EXPIRING');
      assert.ok(w, d);
      assert.equal(w.level, 'info');
      assert.match(w.message, /停徵至 2026-12-31；若於 2027 年以後賣出，稅率依屆時法規（延長案待三讀）/);
    }
    for (const d of ['2026-10-01', '2027-01-04', '2016-12-31']) assert.equal(hasWarn(at(d), 'BOND_ETF_EXEMPTION_EXPIRING'), false, d);
    assert.equal(hasWarn(at('2026-11-06', { taxRateOverride: '0' }), 'BOND_ETF_EXEMPTION_EXPIRING'), false);
    assert.equal(hasWarn(calc({ tradeMode: 'dayTrade', productType: 'bondEtf', entryPrice: '30', tradeDate: '2026-11-06' }), 'BOND_ETF_EXEMPTION_EXPIRING'), false);
  });
});

describe('修正 E6／E7／E8', () => {
  test('[E6] 兩平價、停損價超出漲跌停 → BREAKEVEN_BEYOND_LIMIT／STOPLOSS_BEYOND_LIMIT（訊息含漲停、跌停價）', () => {
    // 當沖 110、參考價 100 → 漲停 110；兩平 110.5 超出
    const r = calc({ tradeMode: 'dayTrade', lots: '1', entryPrice: '110', refPrice: '100' });
    assert.equal(r.breakEven.exitPrice, 110.5);
    assert.equal(r.breakEven.beyondLimit, true);
    const w = warnOf(r, 'BREAKEVEN_BEYOND_LIMIT');
    assert.equal(w.level, 'warn');
    assert.match(w.message, /兩平價 110\.50 超出漲跌停範圍（漲停 110\.00、跌停 90\.00）/);
    // 100 × 10 張、停損 150,000 → 停損價 85.20 低於跌停 90
    const s = calc({ tradeMode: 'dayTrade', lots: '10', entryPrice: '100', refPrice: '100', stopLoss: '150000' });
    assert.equal(s.stopLoss.exitPrice, 85.2);
    assert.match(warnOf(s, 'STOPLOSS_BEYOND_LIMIT').message, /停損價 85\.20 超出漲跌停範圍（漲停 110\.00、跌停 90\.00）/);
    // 範圍內或沒有參考價時不發
    const ok = calc({ tradeMode: 'dayTrade', lots: '10', entryPrice: '100', refPrice: '100', stopLoss: '5000' });
    assert.ok(!hasWarn(ok, 'BREAKEVEN_BEYOND_LIMIT') && !hasWarn(ok, 'STOPLOSS_BEYOND_LIMIT'));
    const noRef = calc({ tradeMode: 'dayTrade', lots: '10', entryPrice: '110', stopLoss: '150000' });
    assert.ok(!hasWarn(noRef, 'BREAKEVEN_BEYOND_LIMIT') && !hasWarn(noRef, 'STOPLOSS_BEYOND_LIMIT'));
  });

  test('[E7] capitalBase ≤ 0 時不論有無目標都發 CAPITAL_BASE_NONPOSITIVE', () => {
    const r = calc({ tradeMode: 'dayTrade', direction: 'short', lots: '1', entryPrice: '0.01', targets: '' });
    assert.equal(r.entry.capitalBase, -10);
    assert.equal(r.targets.length, 0);
    const w = warnOf(r, 'CAPITAL_BASE_NONPOSITIVE');
    assert.ok(w);
    assert.match(w.message, /報酬率分母（進場淨收入）不大於 0/);
    assert.equal(hasWarn(calc({ tradeMode: 'dayTrade', lots: '1', entryPrice: '100', targets: '' }), 'CAPITAL_BASE_NONPOSITIVE'), false);
  });

  test('[E8] 千分位逗號必須符合 1,234 格式，否則視為無法辨識', () => {
    assert.equal(T.parseNumber('43,45'), null);
    assert.equal(T.parseNumber('1,00'), null);
    assert.equal(T.parseNumber('1000,5'), null);
    assert.equal(T.parseNumber(','), null);
    assert.equal(T.parseNumber('1,000'), 1000);
    assert.equal(T.parseNumber('1,000.5'), 1000.5);
    assert.equal(T.parseNumber('12,345,678'), 12345678);
    assert.equal(T.parseNumber('１，０００'), 1000); // 全形先正規化
    assert.equal(T.parseNumber('-5,000'), -5000);
    const bad = calc({ tradeMode: 'dayTrade', lots: '1', entryPrice: '43,45' });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.code === 'ENTRY_PRICE_INVALID'));
    const disc = calc({ tradeMode: 'dayTrade', lots: '1', entryPrice: '100', discount: '2,8' });
    assert.equal(disc.fee.discount, 0.18);
    assert.equal(warnOf(disc, 'INPUT_INVALID').field, 'discount');
    const lots = calc({ tradeMode: 'dayTrade', lots: '1,000', entryPrice: '1,000.5' });
    assert.equal(lots.lots, 1000);
    assert.equal(lots.rawEntryPrice, 1000.5);
    const sl = calc({ tradeMode: 'dayTrade', lots: '10', entryPrice: '100', stopLoss: '-5,000' });
    assert.equal(sl.stopLoss.desiredProfit, -5000);
    assert.equal(hasWarn(calc({ tradeMode: 'dayTrade', lots: '10', entryPrice: '100', exitPrice: '101,5' }), 'EXIT_INVALID'), true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 四、自我對帳：隨機 5,000 組合法輸入（獨立 BigInt 參考模型）
// ════════════════════════════════════════════════════════════════════
const fdiv = (a, b) => { const q = a / b; return (a % b !== 0n && ((a < 0n) !== (b < 0n))) ? q - 1n : q; };
const cdiv = (a, b) => -fdiv(-a, b);
const rhu = (a, b) => fdiv(2n * a + b, 2n * b);
const bmax = (a, b) => (a > b ? a : b);
/** 簡單十進位字串 → 以 10^k 縮放的 BigInt（四捨五入；測試只用一般小數字串） */
function scaled(str, k) {
  const neg = str.startsWith('-');
  const s = neg ? str.slice(1) : str;
  const [ip, fp = ''] = s.split('.');
  const digits = BigInt(ip + fp.padEnd(k, '0').slice(0, k));
  const rest = fp.slice(k);
  const v = rest && rest[0] >= '5' ? digits + 1n : digits;
  return neg ? -v : v;
}
// 獨立的升降單位格點（分）
const BANDS = {
  stock: [[1, 1000, 1], [1000, 5000, 5], [5000, 10000, 10], [10000, 50000, 50], [50000, 100000, 100], [100000, 10000001, 500]],
  etf: [[1, 5000, 1], [5000, 10000001, 5]],
};
const bandsOf = (prod) => (prod === 'stock' ? BANDS.stock : BANDS.etf);
const tickOf = (prod, pc) => bandsOf(prod).find(([, hi]) => pc < hi)[2];
const upOf = (prod, pc) => pc + tickOf(prod, pc);
const downOf = (prod, pc) => (pc <= 1 ? null : pc - tickOf(prod, pc - 1));

// 'YYYY-MM-DD' ＋ n 日曆日（獨立實作，UTC）
function refAddDays(date, n) {
  const t = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + n));
  return t.toISOString().slice(0, 10);
}
function refTaxRate(prod, mode, date) {
  if (prod === 'bondEtf') return date >= '2017-01-01' && date <= '2026-12-31' ? [0n, 1n] : [1n, 1000n];
  if (prod === 'etf') return [1n, 1000n];
  if (mode === 'dayTrade' && date >= '2017-04-28' && date <= '2027-12-31') return [15n, 10000n];
  return [3n, 1000n];
}
function refMinShortPct(date) {
  if (date >= '2026-11-09') return 130;
  if (date >= '2025-05-26') return 90;
  if (date >= '2025-04-07') return 130;
  return 90;
}
function discMicroOf(s) {
  const v = Number(s);
  return v > 1 ? scaled(s, 5) : scaled(s, 6);
}

function makeRef(sc) {
  const long = sc.direction === 'long';
  const mode = sc.tradeMode;
  const lots = BigInt(sc.lots);
  const S = lots * 1000n;
  const G = BigInt(sc.entryC) * S / 100n;
  const disc = discMicroOf(sc.discount);
  const minFee = BigInt(sc.minFee);
  // 融資的證交稅在融資賣出時收取 → 依出場日（交易日期＋融資天數）判斷；其餘模式依交易日期
  const taxDate = mode === 'marginLong' ? refAddDays(sc.tradeDate, Number(sc.marginDays)) : sc.tradeDate;
  const [tn, td] = refTaxRate(sc.productType, mode, taxDate);
  const sfR8 = scaled(sc.shortFeeRate, 6); // % → 1e-8
  const comm = (X) => {
    if (X <= 0n) return { charged: 0n, refund: 0n, net: 0n };
    if (sc.feeModel === 'monthly') {
      const ch = bmax(fdiv(X * 1425n, 1000000n), minFee);
      const rf = fdiv(ch * (1000000n - disc), 1000000n);
      return { charged: ch, refund: rf, net: ch - rf };
    }
    const f = bmax(fdiv(X * 1425n * disc, 1000000000000n), minFee);
    return { charged: f, refund: 0n, net: f };
  };
  const tax = (X) => (X <= 0n || tn === 0n ? 0n : (sc.taxRounding === 'round' ? rhu(X * tn, td) : fdiv(X * tn, td)));
  const sfee = (X) => rhu(X * sfR8, 100000000n);
  const ec = comm(G);
  const etax = long ? 0n : tax(G);
  const esf = (mode === 'marginShort' || (mode === 'creditDayTrade' && !long)) ? sfee(G) : 0n;
  let loan = 0n; let selfFunds = 0n; let C = 0n; let GF = 0n; let iCost = 0n; let iInc = 0n;
  if (mode === 'marginLong') {
    const selfR4 = scaled(sc.marginSelfRatio, 2);
    loan = fdiv(G * (10000n - selfR4), 10000000n) * 1000n;
    selfFunds = G - loan;
    iCost = rhu(loan * scaled(sc.marginInterestRate, 4) * BigInt(sc.marginDays), 365000000n);
  } else if (mode === 'marginShort') {
    // 空白＝依日期最低值；明確輸入時只夾到常態最低 90%（介於 90% 與臨時措施 130% 之間照輸入計算）
    const minPct = refMinShortPct(sc.tradeDate);
    const effPct = sc.shortMarginRatio === '' ? minPct : Math.max(90, Number(sc.shortMarginRatio));
    const smR4 = BigInt(effPct) * 100n;
    C = cdiv(G * smR4, 1000000n) * 100n;
    GF = G - ec.charged - etax - esf;
    iInc = rhu((C + GF) * scaled(sc.shortInterestRate, 4) * BigInt(sc.shortDays), 365000000n);
  }
  let capitalBase;
  if (mode === 'marginLong') capitalBase = selfFunds + ec.net;
  else if (mode === 'marginShort') capitalBase = C;
  else if (long) capitalBase = G + ec.net;
  else capitalBase = G - ec.net - etax - esf;
  const profitAt = (pc) => {
    const X = BigInt(pc) * S / 100n;
    const xc = comm(X);
    const xt = long ? tax(X) : 0n;
    const xs = (mode === 'creditDayTrade' && long) ? sfee(X) : 0n;
    const costs = ec.net + etax + esf + xc.net + xt + xs + iCost - iInc;
    return long ? X - G - costs : G - X - costs;
  };
  return { G, ec, etax, esf, loan, C, GF, iCost, iInc, capitalBase, profitAt, comm, tax, sfee, long, mode };
}

function mulberry32(a) {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('自我對帳', () => {
  test('[對帳] 隨機 5,000 組合法輸入：交割恆等式、損益與獨立模型一致、兩平前一檔損益 < 0', (t) => {
    const rnd = mulberry32(20261106);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const randInt = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const combos = [['dayTrade', 'long'], ['dayTrade', 'short'], ['cash', 'long'], ['marginLong', 'long'], ['marginShort', 'short'], ['creditDayTrade', 'long'], ['creditDayTrade', 'short']];
    const TARGET_POOL = ['0.5', '1', '3', '5', '10', '20', '50', '100', '200', '-0.5', '-1', '-3', '-10', '-50', '-90', '-100', '0', '0.01', '12.34'];
    const stats = { scenarios: 0, trades: 0, beReachable: 0, beUnreachable: 0, targetsUnreachable: 0, monthly: 0, maint: 0 };
    const centsStr = (c) => `${Math.trunc(c / 100)}.${String(c % 100).padStart(2, '0')}`;
    for (let i = 0; i < 5000; i += 1) {
      const [tradeMode, direction] = pick(combos);
      const productType = pick(['stock', 'stock', 'etf', 'bondEtf']);
      const bands = bandsOf(productType);
      const [lo, hi, tk] = pick(bands);
      const span = Math.min((hi - lo) / tk, 4000);
      let entryC = lo + Math.floor(rnd() * span) * tk;
      if (rnd() < 0.05) entryC = randInt(1, 20); // 極低價：涵蓋低消主導、兩平不可達
      if (entryC > 10000000) entryC = 10000000;
      let exitC = entryC;
      const k = randInt(-40, 40);
      for (let j = 0; j < Math.abs(k); j += 1) { const nx = k > 0 ? upOf(productType, exitC) : downOf(productType, exitC); if (nx === null || nx > 10000000) break; exitC = nx; }
      const sc = {
        tradeMode, direction, productType,
        lots: pick([1, 1, 2, 3, 5, 10, 20, 50, 100, 250, 499, 1000, randInt(1, 300)]),
        entryC,
        discount: pick(['1', '0.6', '0.5', '0.38', '0.35', '0.28', '0.2', '0.18', '0.1', '0', '2.8', '6']),
        minFee: pick(['20', '20', '1', '0', '10', '50']),
        feeModel: pick(['instant', 'instant', 'monthly']),
        taxRounding: pick(['floor', 'floor', 'round']),
        tradeDate: pick(['2026-11-06', '2026-11-09', '2027-12-31', '2028-01-03', '2026-12-31', '2027-01-04', '2025-04-10', '2016-12-20', '2026-12-01']),
        marginSelfRatio: pick(['40', '45', '50', '55', '60', '100', '42.5']),
        marginInterestRate: pick(['6.45', '6.25', '0', '6.85', '4']),
        marginDays: pick(['0', '1', '7', '30', '90', '180', '365']),
        shortMarginRatio: pick(['', '', '90', '100', '130', '150', '200', '80', '120']),
        shortFeeRate: pick(['0.08', '0.08', '0.1', '0']),
        shortInterestRate: pick(['0.2', '0.1', '0', '0.05']),
        shortDays: pick(['0', '1', '30', '60', '90']),
      };
      const inputs = {
        ...sc, lots: String(sc.lots), entryPrice: centsStr(entryC), exitPrice: centsStr(exitC),
        stopLoss: pick(['', '1000', '5000', '50000']),
        targets: rnd() < 0.5 ? '3, 2.5, 2, 1, 0, -1, -2' : Array.from({ length: randInt(1, 6) }, () => pick(TARGET_POOL)).join(', '),
        refPrice: '', limitPct: '0.1', taxRateOverride: '',
      };
      delete inputs.entryC;
      const r = T.calculate(inputs);
      const ctxMsg = () => JSON.stringify(inputs);
      assert.equal(r.ok, true, ctxMsg());
      const ref = makeRef(sc);
      stats.scenarios += 1;
      if (sc.feeModel === 'monthly') stats.monthly += 1;

      // 進場金額與獨立模型一致
      assert.equal(r.entry.gross, Number(ref.G), ctxMsg());
      assert.deepEqual([r.entry.commission.charged, r.entry.commission.refund, r.entry.commission.net], [ref.ec.charged, ref.ec.refund, ref.ec.net].map(Number), ctxMsg());
      assert.equal(r.entry.tax, Number(ref.etax), ctxMsg());
      assert.equal(r.entry.shortFee, Number(ref.esf), ctxMsg());
      assert.equal(r.entry.capitalBase, Number(ref.capitalBase), ctxMsg());
      if (tradeMode === 'marginLong') assert.equal(r.entry.loan, Number(ref.loan), ctxMsg());
      if (tradeMode === 'marginLong') {
        // E5：融資出場稅依出場日判斷
        assert.equal(r.tax.basis, 'exit', ctxMsg());
        assert.equal(r.tax.date, refAddDays(sc.tradeDate, Number(sc.marginDays)), ctxMsg());
      } else {
        assert.equal(r.tax.basis, 'trade', ctxMsg());
        assert.equal(r.tax.date, sc.tradeDate, ctxMsg());
      }
      if (tradeMode === 'marginShort') {
        assert.equal(r.entry.collateral, Number(ref.C), ctxMsg());
        assert.equal(r.entry.guaranty, Number(ref.GF), ctxMsg());
        assert.equal(r.entry.interest, Number(ref.iInc), ctxMsg());
      }

      const cents = (p) => Math.round(p * 100);
      const checkTrade = (x, label) => {
        stats.trades += 1;
        const pc = cents(x.exitPrice);
        const msg = () => `${label} @${x.exitPrice} ${ctxMsg()}`;
        // 1) 損益與獨立模型一致
        assert.equal(x.profit, Number(ref.profitAt(pc)), msg());
        // 2) 損益 = 價差 − 總成本
        assert.equal(x.profit, (ref.long ? x.exitGross - r.entry.gross : r.entry.gross - x.exitGross) - x.totalCosts, msg());
        // 3) 交割恆等式（月退制以退款調整為 net）
        const refunds = r.entry.commission.refund + x.exitCommission.refund;
        if (tradeMode === 'dayTrade' || tradeMode === 'creditDayTrade') {
          assert.equal(x.settlement.amount + refunds, x.profit, `當沖交割淨額 ${msg()}`);
        } else {
          assert.equal(x.settlement.amount - r.entry.cashOut + refunds, x.profit, `出場應收 − 進場應付 ${msg()}`);
        }
        // 4) 出場費用與獨立模型一致
        const X = BigInt(x.exitGross);
        const xc = ref.comm(X);
        assert.deepEqual([x.exitCommission.charged, x.exitCommission.net], [Number(xc.charged), Number(xc.net)], msg());
        assert.equal(x.exitTax, ref.long ? Number(ref.tax(X)) : 0, msg());
        assert.equal(x.exitShortFee, (tradeMode === 'creditDayTrade' && ref.long) ? Number(ref.sfee(X)) : 0, msg());
        assert.ok(Number.isInteger(x.profit) && !Object.is(x.profit, -0), msg());
        // E1：維持率 = ⌊分子 × 10000 / 分母⌋ / 100（向下截斷到 0.01%），且 belowCall ⇔ 維持率 < 130
        let num = null; let den = null;
        if (tradeMode === 'marginLong' && ref.loan > 0n) { num = X; den = ref.loan; }
        if (tradeMode === 'marginShort') { num = ref.C + ref.GF; den = X; }
        if (num !== null) {
          assert.equal(x.maintenance, Number(fdiv(num * 10000n, den)) / 100, `維持率 ${msg()}`);
          assert.equal(x.belowCall, num * 100n < 130n * den, `belowCall ${msg()}`);
          assert.equal(x.belowCall, x.maintenance < 130, `belowCall ⇔ 維持率 < 130 ${msg()}`);
          stats.maint += 1;
        } else {
          assert.equal(x.maintenance, null, msg());
          assert.equal(x.belowCall, false, msg());
        }
      };

      checkTrade(r.manualExit, 'manualExit');
      // 兩平：可達時，前一檔（做多往下一檔／做空往上一檔）損益 < 0
      const be = r.breakEven;
      checkTrade(be, 'breakEven');
      const bePc = cents(be.exitPrice);
      if (be.reachable) {
        stats.beReachable += 1;
        assert.ok(be.profit >= 0, ctxMsg());
        const prev = ref.long ? downOf(productType, bePc) : upOf(productType, bePc);
        if (prev !== null) assert.ok(ref.profitAt(prev) < 0n, `兩平前一檔 ${ctxMsg()}`);
      } else {
        stats.beUnreachable += 1;
        if (!ref.long) assert.ok(ref.profitAt(1) < 0n, `做空兩平不可達時 0.01 仍虧損 ${ctxMsg()}`);
      }
      if (r.stopLoss) checkTrade(r.stopLoss, 'stopLoss');
      for (const tg of r.targets) {
        checkTrade(tg, 'target');
        assert.equal(tg.desiredProfit, Number(rhu(ref.capitalBase * scaled(String(tg.targetPct), 6), 100000000n)), ctxMsg());
        if (tg.reachable) {
          assert.ok(tg.profit >= tg.desiredProfit, ctxMsg());
          const pc = cents(tg.exitPrice);
          const prev = ref.long ? downOf(productType, pc) : upOf(productType, pc);
          if (prev !== null) assert.ok(ref.profitAt(prev) < BigInt(tg.desiredProfit), `目標前一檔 ${ctxMsg()}`);
        } else {
          stats.targetsUnreachable += 1;
        }
      }
    }
    t.diagnostic(`情境 ${stats.scenarios}、檢查交易 ${stats.trades} 筆（含維持率 ${stats.maint} 筆）、兩平可達 ${stats.beReachable}／不可達 ${stats.beUnreachable}、目標不可達 ${stats.targetsUnreachable}、月退制情境 ${stats.monthly}`);
    assert.equal(stats.scenarios, 5000);
  });
});
