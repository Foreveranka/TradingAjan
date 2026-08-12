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
/// Commands run on their own clock, because somebody is waiting on the reply.
const KOMUT_ARALIK_MS = 10_000;

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

/** HTML is the message format, so anything interpolated has to be escaped. */
const kacir = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A question wrapped so Telegram makes it tap to copy.
 *
 * The wording is what settles the market, so it is the one thing worth having
 * on the clipboard: paste it into a search and the answer is usually one
 * result away.
 */
const kopyalanabilir = (t) => `<code>${kacir(t)}</code>`;

async function haber(metin) {
  const token = process.env.ALERT_TELEGRAM_TOKEN;
  const chat = process.env.ALERT_TELEGRAM_CHAT;
  console.log(metin.replace(/<\/?code>/g, ''));
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat, text: metin, parse_mode: 'HTML', disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.log('telegram gonderilemedi:', e.message.slice(0, 60));
  }
}

/**
 * Reads replies, so a market the agent cannot price can still be traded by
 * whoever can. The alert carries a short code and the answer comes back as one
 * line from a phone.
 *
 * Only the configured chat is obeyed. This process holds the key, so a bot
 * token that leaks must not become a way to spend the balance: the token lets
 * somebody send messages, and the chat check is what stops those messages
 * being orders.
 */
async function komutlariOku() {
  const token = process.env.ALERT_TELEGRAM_TOKEN;
  const chat = String(process.env.ALERT_TELEGRAM_CHAT ?? '');
  if (!token || !chat) return [];
  const durum = durumOku();
  const offset = durum.sonGuncelleme ? durum.sonGuncelleme + 1 : undefined;
  let r;
  try {
    const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
    url.searchParams.set('timeout', '0');
    if (offset) url.searchParams.set('offset', String(offset));
    r = await (await fetch(url)).json();
  } catch { return []; }
  if (!r?.ok) return [];

  const komutlar = [];
  let son = durum.sonGuncelleme ?? 0;
  for (const u of r.result) {
    son = Math.max(son, u.update_id);
    const msg = u.message ?? u.channel_post;
    if (!msg?.text) continue;
    if (String(msg.chat?.id) !== chat) continue; // baskasinin emri emir degil
    komutlar.push(msg.text.trim());
  }
  if (son !== (durum.sonGuncelleme ?? 0)) {
    const d = durumOku(); d.sonGuncelleme = son; durumYaz(d);
  }
  return komutlar;
}

/** A market's short code: enough to name it in a message, short enough to type. */
const kod = (id) => id.slice(2, 6).toLowerCase();

// --------------------------------------------------------------------- durum

const bosDurum = { gorulen: [], islenen: [], sonOzet: 0, sonGuncelleme: 0 };
const durumOku = () => {
  try { return { ...bosDurum, ...JSON.parse(readFileSync(DURUM, 'utf8')) }; }
  catch { return { ...bosDurum }; }
};
/** Merges rather than overwrites: the command loop and the market loop both
 *  write, and a whole-object write from one silently undoes the other. */
const durumYaz = (yama) => {
  try { writeFileSync(DURUM, JSON.stringify({ ...durumOku(), ...yama }, null, 2)); } catch {}
};

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
    return { p: (gercek.deger < esik) === altinda ? 0.97 : 0.03, not: `NSIDC yayınladı: ${gercek.deger}, eşik ${esik}` };
  }
  const { ort, sap } = degisim(rows);
  const adim = Math.max(gunFarki(tarih, son.tarih), 0);
  const beklenen = son.deger + ort * adim;
  const belirsizlik = Math.max(sap * Math.sqrt(Math.max(adim, 1)), 0.005);
  const pAlt = phi((esik - beklenen) / belirsizlik);
  return {
    p: Math.min(0.97, Math.max(0.03, altinda ? pAlt : 1 - pAlt)),
    not: `NSIDC son ölçüm ${son.tarih}: ${son.deger}. ${tarih} için beklenen ~${beklenen.toFixed(3)}, eşik ${esik}`,
  };
}

function lekeTahmini(rows, tarih, esik) {
  const gercek = rows.find((r) => r.tarih === tarih);
  if (gercek) {
    const oran = gercek.deger / Math.max(esik, 1);
    return {
      p: gercek.deger >= esik ? Math.min(0.97, 0.7 + 0.27 * Math.min(oran - 1, 1))
                              : Math.max(0.03, 0.3 - 0.27 * Math.min(1 - oran, 1)),
      not: `SILSO yayınladı: ${gercek.deger}, eşik ${esik}`,
    };
  }
  const son7 = rows.slice(0, 7).map((r) => r.deger);
  const ort = son7.reduce((a, b) => a + b, 0) / son7.length;
  const sap = Math.sqrt(son7.reduce((a, b) => a + (b - ort) ** 2, 0) / son7.length) || 15;
  return {
    p: Math.min(0.9, Math.max(0.1, phi((ort - esik) / Math.max(sap, 5)))),
    not: `SILSO henüz yayınlamadı. Son 7 gün ortalaması ${ort.toFixed(0)}, sapma ${sap.toFixed(0)}`,
  };
}

function tani(soru) {
  let m = soru.match(/NSIDC Arctic sea ice extent for (\d{4}-\d{2}-\d{2}).*?be (below|above) ([\d.]+) million/i);
  if (m) return { tur: 'buz', tarih: m[1], altinda: m[2].toLowerCase() === 'below', esik: Number(m[3]) };
  m = soru.match(/SILSO estimated sunspot number for (\d{4}-\d{2}-\d{2}).*?be (\d+) or higher/i);
  if (m) return { tur: 'leke', tarih: m[1], esik: Number(m[2]) };
  return null;
}

/**
 * Runs one order that came in from the phone.
 *
 * Deliberately narrow. It buys a named outcome in a named market for a named
 * number of tokens, and refuses anything it cannot read exactly: a market it
 * cannot find, an outcome that is not on the ticket, an amount above the cap.
 * A trading command parsed loosely is a trading command that eventually buys
 * the wrong side of something.
 */
async function komutIsle(metin, markets, nakit) {
  // `/liste`, `Liste` and `liste` are the same intent typed three ways.
  const p = metin.trim().toLowerCase().replace(/^\//, '').split(/\s+/);

  if (p[0] === 'durum') {
    const me = (await client.getSigner()).address;
    const pos = await client.listPositions({ wallet: me }).catch(() => ({ positions: [] }));
    const acik = (pos.positions ?? []).filter((x) => x.marketStatus === 'open');
    await haber(`📊 DURUM\n\nNakit: ${nakit.toFixed(0)} TST\nAçık pozisyon: ${acik.length}`);
    return true;
  }

  if (p[0] === 'poz' || p[0] === 'pozisyon') {
    const me = (await client.getSigner()).address;
    const pos = await client.listPositions({ wallet: me }).catch(() => ({ positions: [] }));
    const hepsi = (pos.positions ?? []).filter((x) => !x.redeemedOrLiquidated);
    if (!hepsi.length) { await haber('Açık pozisyon yok.'); return true; }

    // Each position names a market but not its question, and a settled market
    // is not in the open list, so each one is fetched on its own.
    const satirlar = [];
    const konular = {};
    let toplamDeger = 0;

    for (const x of hepsi) {
      let m = null;
      try { m = await client.getMarket({ id: x.marketProxy, pricesAndImpliedProbabilities: true }); }
      catch { /* piyasa okunamadi, yine de pozisyonu goster */ }

      const hisse = Number(x.shares) / 1e18;
      const sonuc = m?.metadata?.outcomes?.[Number(x.outcomeIdx)] ?? `#${x.outcomeIdx}`;
      const konu = m?.metadata?.category ?? m?.category ?? 'bilinmiyor';
      const fiyat = m?.spotImpliedProbabilities?.[Number(x.outcomeIdx)];

      // Worth now, not what it cost: a position is only ever worth what it
      // would fetch, and at settlement a winning share pays exactly one.
      const deger = fiyat != null ? hisse * fiyat : null;
      if (deger != null) toplamDeger += deger;
      konular[konu] = (konular[konu] ?? 0) + (deger ?? 0);

      const durumEtiketi = { open: 'açık', settled: 'uzlaştı', expired: 'süresi doldu' }[x.marketStatus] ?? x.marketStatus;
      satirlar.push(
        `<b>${kacir(sonuc)}</b> × ${hisse.toFixed(0)} hisse  (${durumEtiketi})\n`
        + `Şu anki değeri: ${deger != null ? deger.toFixed(0) + ' TST' : '?'}`
        + `${fiyat != null ? `  ·  piyasa %${(fiyat * 100).toFixed(0)}` : ''}\n`
        + `Kazanırsa: ${hisse.toFixed(0)} TST\n`
        + `${kopyalanabilir((m?.metadata?.question ?? x.marketProxy).slice(0, 110))}`,
      );
    }

    const konuSatiri = Object.entries(konular)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v.toFixed(0)} TST`).join('  ·  ');

    const { balance } = await client.getErc20BalanceWithDecimals();
    const nakitSimdi = toTst(balance);
    await haber(
      `📌 AÇIK POZİSYONLAR (${hepsi.length})\n\n${satirlar.join('\n\n')}\n\n`
      + `———\nKonulara göre: ${konuSatiri || 'yok'}\n`
      + `Pozisyonların şu anki değeri: ${toplamDeger.toFixed(0)} TST\n`
      + `Nakit: ${nakitSimdi.toFixed(0)} TST\n`
      + `Toplam: ${(toplamDeger + nakitSimdi).toFixed(0)} TST  (başlangıç 1000)`,
    );
    return true;
  }

  if (p[0] === 'liste') {
    const satirlar = markets.map((m) => {
      const f = (m.metadata?.outcomes ?? [])
        .map((o, i) => `${o} %${(m.spotImpliedProbabilities?.[i] * 100).toFixed(0)}`).join(' / ');
      return `<b>${kod(m.id)}</b>  ${kacir(f)}\n${kopyalanabilir((m.metadata?.question ?? '').slice(0, 110))}`;
    });
    await haber(`📋 AÇIK PİYASALAR (${markets.length})\n\n${satirlar.join('\n\n')}`.slice(0, 3900));
    return true;
  }

  if (p[0] !== 'al') return false;

  const [, hedefKod, sonucAdi, miktarStr] = p;
  const miktar = Number(miktarStr);
  if (!hedefKod || !sonucAdi || !Number.isFinite(miktar) || miktar <= 0) {
    await haber('Anlamadım. Şöyle yaz:  al <kod> <sonuç> <tst>\nÖrnek:  al a3f yes 100');
    return true;
  }
  if (miktar > TEK_ISLEM_TAVAN) {
    await haber(`Tek işlemde en fazla ${TEK_ISLEM_TAVAN} TST. İstediğin: ${miktar}.`);
    return true;
  }
  if (miktar > nakit - 5) {
    await haber(`Nakit yetmiyor. Elde ${nakit.toFixed(0)} TST var, istediğin ${miktar}.`);
    return true;
  }

  const m = markets.find((x) => kod(x.id) === hedefKod);
  if (!m) { await haber(`"${kacir(hedefKod)}" kodlu açık piyasa yok. Listeyi görmek için:  liste`); return true; }

  const outcomes = m.metadata?.outcomes ?? [];
  const idx = outcomes.findIndex((o) => o.toLowerCase() === sonucAdi
    || o.toLowerCase().startsWith(sonucAdi));
  if (idx < 0) {
    await haber(`Bu piyasada "${kacir(sonucAdi)}" diye bir sonuç yok.\nSeçenekler: ${kacir(outcomes.join(', '))}`);
    return true;
  }

  const fiyat = m.spotImpliedProbabilities?.[idx] ?? 0.5;
  const hisse = Math.floor(miktar / Math.max(fiyat, 0.02));
  const sharesOut = BigInt(hisse) * SHARE;
  let tokensIn;
  try { ({ tokensIn } = await client.quoteBuy({ marketAddress: m.id, outcomeIdx: idx, sharesOut })); }
  catch (e) { await haber(`Teklif alınamadı: ${kacir(e.message.slice(0, 100))}`); return true; }

  const maliyet = toTst(tokensIn);
  const maxTokensIn = (tokensIn * BigInt(Math.round(KAYMA * 100))) / 100n;
  try {
    await client.ensureTokenApproval({ marketAddress: m.id, minimumAmount: maxTokensIn, approveAmount: maxTokensIn });
    const { transactionHash } = await client.buyShares({ marketAddress: m.id, outcomeIdx: idx, sharesOut, maxTokensIn });
    await haber(
      `✅ SENİN EMRİN GİRİLDİ\n\n${kopyalanabilir(m.metadata?.question)}\n\n`
      + `Alınan: ${outcomes[idx]}, ${hisse} hisse\n`
      + `Maliyet: ${maliyet.toFixed(0)} TST (ortalama %${(maliyet / hisse * 100).toFixed(0)})\n`
      + `Kazanırsa: +${(hisse - maliyet).toFixed(0)} TST\n\n`
      + `Kalan nakit: ${(nakit - maliyet).toFixed(0)} TST`,
    );
  } catch (e) {
    await haber(`⚠️ Emir girilemedi.\n\n${kacir(e.message.slice(0, 160))}`);
  }
  return true;
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
        await haber(
          `🆕 YENİ PİYASA\n\n${kopyalanabilir(soru)}\n\n`
          + `Fiyatlar: ${fiyat}\n`
          + `Uzlaşma: ${(m.settlesAt ?? '').slice(0, 16).replace('T', ' ')}\n\n`
          + `Bunu ajan fiyatlayamıyor, elle bakılmalı.\n`
          + `Kod: ${kod(m.id)}\n\n`
          + `Karar verdiysen şöyle yaz:  al ${kod(m.id)} ${(m.metadata?.outcomes ?? ['yes'])[0]} 100`,
        );
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
        `✅ İŞLEM AÇILDI\n\n${kopyalanabilir(soru)}\n\n`
        + `Alınan: ${yon}, ${hisse} hisse\n`
        + `Maliyet: ${maliyet.toFixed(0)} TST (ortalama %${(maliyet / hisse * 100).toFixed(0)})\n`
        + `Kazanırsa: +${(hisse - maliyet).toFixed(0)} TST\n\n`
        + `Benim tahminim: %${(tahmin.p * 100).toFixed(0)}\n`
        + `Piyasanın fiyatı: %${(piyasa * 100).toFixed(0)}\n`
        + `Aradaki fark: ${Math.abs(fark * 100).toFixed(0)} puan\n\n`
        + `Dayandığım veri: ${tahmin.not}\n\n`
        + `Kalan nakit: ${nakit.toFixed(0)} TST`,
      );
    } catch (e) {
      await haber(`⚠️ İŞLEM AÇILAMADI\n\n${kopyalanabilir(soru)}\n\nSebep: ${kacir(e.message.slice(0, 140))}`);
    }
  }

  // One line a day, so the thing is known to be alive without being noisy.
  if (Date.now() - (durum.sonOzet || 0) > 12 * 3600_000) {
    durum.sonOzet = Date.now();
    const me = (await client.getSigner()).address;
    const pos = await client.listPositions({ wallet: me }).catch(() => ({ positions: [] }));
    const acik = (pos.positions ?? []).filter((p) => p.marketStatus === 'open').length;
    await haber(
      `📊 GÜNLÜK DURUM\n\n`
      + `Nakit: ${nakit.toFixed(0)} TST\n`
      + `Açık pozisyon: ${acik}\n`
      + `İzlenen piyasa: ${markets.length}`,
    );
  }

  durumYaz(durum);
}

// ------------------------------------------------------------------ donguler

/**
 * Commands are read on their own clock.
 *
 * They were folded into the market scan, which meant a message typed from a
 * phone waited up to five minutes for an answer. Scanning markets is slow work
 * that costs an RPC fan-out; reading a mailbox is not, so the two run apart and
 * the one a person is waiting on runs often.
 */
async function komutDongusu() {
  for (;;) {
    try {
      const komutlar = await komutlariOku();
      if (komutlar.length) {
        const liste = await client.listMarkets({
          status: 'open', pricesAndImpliedProbabilities: true, limit: 50,
        });
        const { balance } = await client.getErc20BalanceWithDecimals();
        let nakit = toTst(balance);
        for (const k of komutlar) {
          const tanindi = await komutIsle(k, liste.markets ?? [], nakit);
          if (!tanindi) {
            await haber(
              `Bunu anlamadım: <code>${kacir(k)}</code>\n\n`
              + `Komutlar:\n<b>liste</b> — açık piyasalar\n<b>poz</b> — açık pozisyonlar\n`
              + `<b>durum</b> — nakit ve özet\n<b>al &lt;kod&gt; &lt;sonuç&gt; &lt;tst&gt;</b> — işlem aç`,
            );
          }
          const b = await client.getErc20BalanceWithDecimals();
          nakit = toTst(b.balance);
        }
      }
    } catch (e) {
      console.log(new Date().toISOString(), 'komut hatasi:', e.message.slice(0, 140));
    }
    await new Promise((r) => setTimeout(r, KOMUT_ARALIK_MS));
  }
}

async function piyasaDongusu() {
  for (;;) {
    try { await tur(); }
    catch (e) { console.log(new Date().toISOString(), 'tur hatasi:', e.message.slice(0, 140)); }
    await new Promise((r) => setTimeout(r, ARALIK_MS));
  }
}

await haber('🔭 Anka nöbette. Piyasalara beş dakikada bir bakıyorum, komutlarını on saniyede bir okuyorum.');
await Promise.all([komutDongusu(), piyasaDongusu()]);
