/**
 * Anka: prices the questions that have an answer, ignores the ones that do not.
 *
 * The competition keeps opening markets, and a market nobody has traded yet
 * sits at its initial price, which reflects nothing. Two of the templates
 * recur with a new date each day:
 *
 *   Will NSIDC Arctic sea ice extent for YYYY-MM-DD be below N million km²?
 *   Will the SILSO estimated sunspot number for YYYY-MM-DD be N or higher?
 *
 * Both resolve against a file a public body publishes daily. So the answer is
 * not forecast here, it is fetched, and the only judgement left is how much
 * the last observed value can move before the date in question.
 *
 * Everything else is left alone. Whether OpenAI announces a model or Rockstar
 * publishes a number is somebody's decision, and having no better information
 * than the market means paying the spread to express nothing.
 *
 * Runs read only unless --al is passed.
 */
import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

const AL = process.argv.includes('--al');
const client = new DelphiClient();
const SHARE = 10n ** 18n;
const { decimals: DEC } = await client.getErc20BalanceWithDecimals();
const toTst = (raw) => Number(raw) / 10 ** DEC;

/// Only act when the gap is this wide. Below it the edge does not survive the
/// spread that LMSR charges for size.
const ESIK = 0.08;
/// Never put more than this share of the bankroll behind one question.
const MAX_PAY = 0.35;
const KAYMA = 1.02;

// ---------------------------------------------------------------- veri

/** NSIDC daily extent, most recent first. */
async function buzVerisi() {
  const url = 'https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_daily_v4.0.csv';
  const text = await (await fetch(url)).text();
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d{4}),\s*(\d{2}),\s*(\d{2}),\s*([\d.]+)/);
    if (m) rows.push({ tarih: `${m[1]}-${m[2]}-${m[3]}`, deger: Number(m[4]) });
  }
  return rows.reverse();
}

/** SILSO estimated sunspot number, most recent first. */
async function lekeVerisi() {
  const url = 'https://www.sidc.be/SILSO/DATA/EISN/EISN_current.csv';
  const text = await (await fetch(url)).text();
  const rows = [];
  for (const line of text.split('\n')) {
    const p = line.split(',').map((x) => x.trim());
    if (p.length >= 5 && /^\d{4}$/.test(p[0])) {
      rows.push({ tarih: `${p[0]}-${p[1]}-${p[2]}`, deger: Number(p[4]) });
    }
  }
  return rows.reverse();
}

const gunFarki = (a, b) => Math.round((new Date(a) - new Date(b)) / 86_400_000);

/** Normal CDF, Abramowitz and Stegun 26.2.17. */
function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** Mean and standard deviation of the day over day change. */
function degisim(rows, n = 10) {
  const d = [];
  for (let i = 0; i < Math.min(n, rows.length - 1); i += 1) d.push(rows[i].deger - rows[i + 1].deger);
  const ort = d.reduce((a, b) => a + b, 0) / d.length;
  const sap = Math.sqrt(d.reduce((a, b) => a + (b - ort) ** 2, 0) / d.length);
  return { ort, sap: sap || 0.02 };
}

// ------------------------------------------------------------ tahminciler

/**
 * Sea ice melts through August at a rate the last week measures better than
 * any model worth writing here. Confidence falls the further the target date
 * is from the last reading, because the projection is doing more of the work.
 */
function buzTahmini(rows, hedefTarih, esik, altinda) {
  const son = rows[0];
  if (!son) return null;
  const gun = gunFarki(hedefTarih, son.tarih);
  if (gun < 0) {
    // Already published: no forecast, just a fact.
    const gercek = rows.find((r) => r.tarih === hedefTarih);
    if (gercek) return { p: (gercek.deger < esik) === altinda ? 0.99 : 0.01, not: `yayinlandi: ${gercek.deger}` };
  }
  // The distribution of daily changes, measured rather than assumed. The first
  // version divided the margin by an arbitrary width and returned 59% for a
  // threshold the data had already crossed, which would have reversed a
  // correct position.
  const { ort, sap } = degisim(rows);
  const adim = Math.max(gun, 0);
  const beklenen = son.deger + ort * adim;
  // A random walk widens with the square root of the number of steps.
  const belirsizlik = Math.max(sap * Math.sqrt(Math.max(adim, 1)), 0.005);
  const z = (esik - beklenen) / belirsizlik;
  const pAltinda = phi(z);
  const p = Math.min(0.97, Math.max(0.03, altinda ? pAltinda : 1 - pAltinda));
  return {
    p,
    not: `son ${son.tarih}=${son.deger}, gunluk ${ort.toFixed(3)}+-${sap.toFixed(3)}, `
       + `${hedefTarih} icin ~${beklenen.toFixed(3)} (esikten ${(esik - beklenen).toFixed(3)} uzak)`,
  };
}

/**
 * Sunspot counts jump around day to day, so a value already published is worth
 * far more than a projection from the week's mean.
 */
function lekeTahmini(rows, hedefTarih, esik) {
  const gercek = rows.find((r) => r.tarih === hedefTarih);
  if (gercek) {
    // Published. The only doubt left is revision, and a wide margin survives it.
    const oran = gercek.deger / Math.max(esik, 1);
    const p = gercek.deger >= esik ? Math.min(0.97, 0.7 + 0.27 * Math.min(oran - 1, 1))
                                   : Math.max(0.03, 0.3 - 0.27 * Math.min(1 - oran, 1));
    return { p, not: `yayinlandi: ${gercek.deger} (esik ${esik})` };
  }
  // Not published yet, so the week's spread is the whole story. Sunspot counts
  // swing hard day to day, so this stays deliberately unconfident.
  const son7 = rows.slice(0, 7).map((r) => r.deger);
  const ort = son7.reduce((a, b) => a + b, 0) / son7.length;
  const sapma = Math.sqrt(son7.reduce((a, b) => a + (b - ort) ** 2, 0) / son7.length) || 15;
  const p = Math.min(0.9, Math.max(0.1, phi((ort - esik) / Math.max(sapma, 5))));
  return { p, not: `henuz yayinlanmadi, 7 gun ort ${ort.toFixed(0)} +-${sapma.toFixed(0)}` };
}

// ---------------------------------------------------------------- eslestirme

/** Recognises the two templates and pulls the numbers out of the sentence. */
function tani(soru) {
  let m = soru.match(/NSIDC Arctic sea ice extent for (\d{4}-\d{2}-\d{2}).*?be (below|above) ([\d.]+) million/i);
  if (m) return { tur: 'buz', tarih: m[1], altinda: m[2].toLowerCase() === 'below', esik: Number(m[3]) };

  m = soru.match(/SILSO estimated sunspot number for (\d{4}-\d{2}-\d{2}).*?be (\d+) or higher/i);
  if (m) return { tur: 'leke', tarih: m[1], esik: Number(m[2]) };

  return null;
}

// ---------------------------------------------------------------- calistir

const [buz, leke, { markets }] = await Promise.all([
  buzVerisi(), lekeVerisi(),
  client.listMarkets({ status: 'open', pricesAndImpliedProbabilities: true, limit: 50 }),
]);

const me = (await client.getSigner()).address;
const { balance } = await client.getErc20BalanceWithDecimals();
const nakit = toTst(balance);
console.log(`nakit ${nakit.toFixed(1)} TST   piyasa ${markets.length}   ${AL ? 'ALIM ACIK' : 'sadece bakiyor'}\n`);

for (const m of markets) {
  const soru = m.metadata?.question ?? '';
  const k = tani(soru);
  if (!k) continue;

  const tahmin = k.tur === 'buz'
    ? buzTahmini(buz, k.tarih, k.esik, k.altinda)
    : lekeTahmini(leke, k.tarih, k.esik);
  if (!tahmin) continue;

  // Index 0 is Yes in both templates.
  const piyasa = m.spotImpliedProbabilities?.[0];
  const fark = tahmin.p - piyasa;
  const yon = fark > 0 ? 'Yes' : 'No';
  const idx = fark > 0 ? 0 : 1;
  // The price of the side being bought, and so the ceiling on its return.
  const bizim = fark > 0 ? tahmin.p : 1 - tahmin.p;
  const onun = fark > 0 ? piyasa : 1 - piyasa;

  console.log(soru);
  console.log(`   veri   : ${tahmin.not}`);
  console.log(`   tahmin ${(tahmin.p * 100).toFixed(1)}%  piyasa ${(piyasa * 100).toFixed(1)}%  fark ${(fark * 100).toFixed(1)} puan`);

  if (Math.abs(fark) < ESIK) { console.log('   GECILDI, fark dar\n'); continue; }

  const butce = Math.min(nakit * MAX_PAY, nakit - 20);
  if (butce < 20) { console.log('   GECILDI, nakit yok\n'); continue; }

  // Buy as many shares as the budget covers at the quoted average.
  const hisse = Math.floor(butce / Math.max(onun, 0.05));
  const sharesOut = BigInt(hisse) * SHARE;
  const { tokensIn } = await client.quoteBuy({ marketAddress: m.id, outcomeIdx: idx, sharesOut });
  const maliyet = toTst(tokensIn);
  console.log(`   ${yon} x${hisse} = ${maliyet.toFixed(1)} TST (ort ${(maliyet / hisse * 100).toFixed(1)}%)`);

  if (!AL) { console.log('   (alim kapali)\n'); continue; }

  const maxTokensIn = (tokensIn * BigInt(Math.round(KAYMA * 100))) / 100n;
  try {
    await client.ensureTokenApproval({ marketAddress: m.id, minimumAmount: maxTokensIn, approveAmount: maxTokensIn });
    const { transactionHash } = await client.buyShares({ marketAddress: m.id, outcomeIdx: idx, sharesOut, maxTokensIn });
    console.log(`   ALINDI ${transactionHash}\n`);
  } catch (e) {
    console.log(`   ALINAMADI: ${e.message.slice(0, 120)}\n`);
  }
}
