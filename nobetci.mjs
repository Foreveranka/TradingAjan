/**
 * Anka on watch: finds the new market before the price does.
 *
 * A market nobody has traded sits at its initial price, which reflects nothing
 * at all. That is the only reliable edge in this competition, and it decays
 * within hours as other agents arrive, so the whole point of this file is to be
 * early. Checking by hand every few minutes is not a plan; this runs on the
 * server and speaks up when there is something to say.
 *
 * What it will trade by itself: only the templates whose answer is published
 * by an institution and fetched here. Ice extent and sunspot counts are facts
 * with a URL. Whether a company makes an announcement is not, and holding no
 * better information than the market means paying the spread to express
 * nothing.
 *
 * What it will not do quietly: a market it cannot price is sent to Telegram
 * with its question and price, because a human reading one sentence can often
 * settle in a minute what no amount of parsing here would.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

const DURUM = new URL('./nobetci-durum.json', import.meta.url).pathname;
const ARALIK_MS = 5 * 60_000;

/// Never risk more than this on one question, whatever the edge looks like.
const TEK_ISLEM_TAVAN = 500;
/// Keep this much back so a new market never finds us with empty hands.
const YEDEK = 60;
/// Below this gap the edge does not survive what LMSR charges for size.
const ESIK = 0.08;
/// A gap this wide is worth the full allowance.
const GUCLU = 0.25;
const KAYMA = 1.02;

const client = new DelphiClient();
const SHARE = 10n ** 18n;
const { decimals: DEC } = await client.getErc20BalanceWithDecimals();
const toTst = (raw) => Number(raw) / 10 ** DEC;

// ------------------------------------------------------------------ telegram

async function haber(metin) {
  const token = process.env.ALERT_TELEGRAM_TOKEN;
  const chat = process.env.ALERT_TELEGRAM_CHAT;
  console.log(metin);
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: metin, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.log('telegram gonderilemedi:', e.message.slice(0, 60));
  }
}

// --------------------------------------------------------------------- durum

const bosDurum = { gorulen: [], islenen: [], sonOzet: 0 };
const durumOku = () => {
  try { return { ...bosDurum, ...JSON.parse(readFileSync(DURUM, 'utf8')) }; }
  catch { return { ...bosDurum }; }
};
const durumYaz = (d) => { try { writeFileSync(DURUM, JSON.stringify(d, null, 2)); } catch {} };

// ---------------------------------------------------------------------- veri

async function csv(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'anka/1.0' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

async function buzVerisi() {
  const text = await csv('https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_daily_v4.0.csv');
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d{4}),\s*(\d{2}),\s*(\d{2}),\s*([\d.]+)/);
    if (m) rows.push({ tarih: `${m[1]}-${m[2]}-${m[3]}`, deger: Number(m[4]) });
  }
  return rows.reverse();
}

async function lekeVerisi() {
  const text = await csv('https://www.sidc.be/SILSO/DATA/EISN/EISN_current.csv');
  const rows = [];
  for (const line of text.split('\n')) {
    const p = line.split(',').map((x) => x.trim());
    if (p.length >= 5 && /^\d{4}$/.test(p[0])) rows.push({ tarih: `${p[0]}-${p[1]}-${p[2]}`, deger: Number(p[4]) });
  }
  return rows.reverse();
}

// ----------------------------------------------------------------- tahminler

/** Normal CDF, Abramowitz and Stegun 26.2.17. */
function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function degisim(rows, n = 10) {
  const d = [];
  for (let i = 0; i < Math.min(n, rows.length - 1); i += 1) d.push(rows[i].deger - rows[i + 1].deger);
  const ort = d.reduce((a, b) => a + b, 0) / d.length;
  return { ort, sap: Math.sqrt(d.reduce((a, b) => a + (b - ort) ** 2, 0) / d.length) || 0.02 };
}

const gunFarki = (a, b) => Math.round((new Date(a) - new Date(b)) / 86_400_000);

function buzTahmini(rows, tarih, esik, altinda) {
  const son = rows[0];
  if (!son) return null;
  const gercek = rows.find((r) => r.tarih === tarih);
  if (gercek) {
    return { p: (gercek.deger < esik) === altinda ? 0.97 : 0.03, not: `yayinlandi ${gercek.deger}` };
  }
  const { ort, sap } = degisim(rows);
  const adim = Math.max(gunFarki(tarih, son.tarih), 0);
  const beklenen = son.deger + ort * adim;
  const belirsizlik = Math.max(sap * Math.sqrt(Math.max(adim, 1)), 0.005);
  const pAlt = phi((esik - beklenen) / belirsizlik);
  return {
    p: Math.min(0.97, Math.max(0.03, altinda ? pAlt : 1 - pAlt)),
    not: `son ${son.tarih}=${son.deger}, ${tarih} icin ~${beklenen.toFixed(3)}, esik ${esik}`,
  };
}

function lekeTahmini(rows, tarih, esik) {
  const gercek = rows.find((r) => r.tarih === tarih);
  if (gercek) {
    const oran = gercek.deger / Math.max(esik, 1);
    return {
      p: gercek.deger >= esik ? Math.min(0.97, 0.7 + 0.27 * Math.min(oran - 1, 1))
                              : Math.max(0.03, 0.3 - 0.27 * Math.min(1 - oran, 1)),
      not: `yayinlandi ${gercek.deger}, esik ${esik}`,
    };
  }
  const son7 = rows.slice(0, 7).map((r) => r.deger);
  const ort = son7.reduce((a, b) => a + b, 0) / son7.length;
  const sap = Math.sqrt(son7.reduce((a, b) => a + (b - ort) ** 2, 0) / son7.length) || 15;
  return {
    p: Math.min(0.9, Math.max(0.1, phi((ort - esik) / Math.max(sap, 5)))),
    not: `henuz yok, 7 gun ort ${ort.toFixed(0)}+-${sap.toFixed(0)}`,
  };
}

function tani(soru) {
  let m = soru.match(/NSIDC Arctic sea ice extent for (\d{4}-\d{2}-\d{2}).*?be (below|above) ([\d.]+) million/i);
  if (m) return { tur: 'buz', tarih: m[1], altinda: m[2].toLowerCase() === 'below', esik: Number(m[3]) };
  m = soru.match(/SILSO estimated sunspot number for (\d{4}-\d{2}-\d{2}).*?be (\d+) or higher/i);
  if (m) return { tur: 'leke', tarih: m[1], esik: Number(m[2]) };
  return null;
}

// ------------------------------------------------------------------- tur

async function tur() {
  const durum = durumOku();
  const [buz, leke, liste] = await Promise.all([
    buzVerisi().catch(() => []), lekeVerisi().catch(() => []),
    client.listMarkets({ status: 'open', pricesAndImpliedProbabilities: true, limit: 50 }),
  ]);
  const markets = liste.markets ?? [];
  const { balance } = await client.getErc20BalanceWithDecimals();
  let nakit = toTst(balance);

  for (const m of markets) {
    const soru = m.metadata?.question ?? '';
    const yeni = !durum.gorulen.includes(m.id);
    const k = tani(soru);

    // A market this cannot price is still worth knowing about, once.
    if (yeni) {
      durum.gorulen.push(m.id);
      if (!k) {
        const fiyat = (m.metadata?.outcomes ?? [])
          .map((o, i) => `${o} ${(m.spotImpliedProbabilities?.[i] * 100).toFixed(0)}%`).join('  ');
        await haber(`YENI PIYASA (elle bakilmali)\n${soru}\n${fiyat}\nuzlasma ${(m.settlesAt ?? '').slice(0, 16)}`);
      }
    }

    if (!k || buz.length === 0 && k.tur === 'buz') continue;
    if (durum.islenen.includes(m.id)) continue;

    const tahmin = k.tur === 'buz' ? buzTahmini(buz, k.tarih, k.esik, k.altinda)
                                   : lekeTahmini(leke, k.tarih, k.esik);
    if (!tahmin) continue;

    const piyasa = m.spotImpliedProbabilities?.[0];
    if (piyasa == null) continue;
    const fark = tahmin.p - piyasa;
    if (Math.abs(fark) < ESIK) continue;

    const idx = fark > 0 ? 0 : 1;
    const yon = m.metadata.outcomes[idx];
    const onunFiyati = fark > 0 ? piyasa : 1 - piyasa;

    // Size on the size of the disagreement, capped, and never into the reserve.
    const oran = Math.min(1, (Math.abs(fark) - ESIK) / (GUCLU - ESIK));
    const butce = Math.min(TEK_ISLEM_TAVAN, Math.max(0, nakit - YEDEK) * (0.35 + 0.65 * oran));
    if (butce < 25) continue;

    const hisse = Math.floor(butce / Math.max(onunFiyati, 0.05));
    const sharesOut = BigInt(hisse) * SHARE;
    let tokensIn;
    try { ({ tokensIn } = await client.quoteBuy({ marketAddress: m.id, outcomeIdx: idx, sharesOut })); }
    catch { continue; }
    const maliyet = toTst(tokensIn);
    if (maliyet > nakit - YEDEK) continue;

    const maxTokensIn = (tokensIn * BigInt(Math.round(KAYMA * 100))) / 100n;
    try {
      await client.ensureTokenApproval({ marketAddress: m.id, minimumAmount: maxTokensIn, approveAmount: maxTokensIn });
      const { transactionHash } = await client.buyShares({ marketAddress: m.id, outcomeIdx: idx, sharesOut, maxTokensIn });
      nakit -= maliyet;
      durum.islenen.push(m.id);
      await haber(
        `ISLEM ACILDI\n${soru}\n${yon} x${hisse} = ${maliyet.toFixed(0)} TST (ort ${(maliyet / hisse * 100).toFixed(0)}%)\n`
        + `tahmin ${(tahmin.p * 100).toFixed(0)}% piyasa ${(piyasa * 100).toFixed(0)}% fark ${(fark * 100).toFixed(0)} puan\n`
        + `veri: ${tahmin.not}\nkalan nakit ${nakit.toFixed(0)} TST`,
      );
    } catch (e) {
      await haber(`ISLEM ACILAMADI\n${soru}\n${e.message.slice(0, 120)}`);
    }
  }

  // One line a day, so the thing is known to be alive without being noisy.
  if (Date.now() - (durum.sonOzet || 0) > 12 * 3600_000) {
    durum.sonOzet = Date.now();
    const me = (await client.getSigner()).address;
    const pos = await client.listPositions({ wallet: me }).catch(() => ({ positions: [] }));
    const acik = (pos.positions ?? []).filter((p) => p.marketStatus === 'open').length;
    await haber(`ANKA DURUM\nnakit ${nakit.toFixed(0)} TST, acik pozisyon ${acik}, izlenen piyasa ${markets.length}`);
  }

  durumYaz(durum);
}

// ------------------------------------------------------------------ dongu

await haber('ANKA nobete basladi');
for (;;) {
  try { await tur(); }
  catch (e) { console.log(new Date().toISOString(), 'tur hatasi:', e.message.slice(0, 140)); }
  await new Promise((r) => setTimeout(r, ARALIK_MS));
}
