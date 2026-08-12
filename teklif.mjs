/**
 * What a position would actually cost, before anything is signed.
 *
 * LMSR moves the price as you buy, so the quoted average is worse than the
 * screen price and gets worse the larger the order. The only way to know what
 * a given budget buys is to ask, so this walks share counts until the cost
 * lands near the budget and prints the average price it would really pay.
 *
 * Read only. Nothing here signs.
 */
import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

const client = new DelphiClient();
/** Shares carry 18 decimals. The collateral does not: TST has 6, so a cost
 *  divided by 1e18 rounds to zero and a position looks free. Read, never
 *  assumed, because the two being different is exactly the trap. */
const SHARE = 10n ** 18n;
const { decimals: TOKEN_DEC } = await client.getErc20BalanceWithDecimals();
const toTst = (raw) => Number(raw) / 10 ** TOKEN_DEC;
console.log(`teminat ondaligi: ${TOKEN_DEC}\n`);

/** The three the research supports, with what to spend on each. */
const PLAN = [
  { ara: 'Arctic sea ice', sonuc: 'Yes', butce: 400 },
  { ara: 'CRS-35', sonuc: 'No', butce: 300 },
  { ara: 'sunspot', sonuc: 'Yes', butce: 200 },
];

const { markets } = await client.listMarkets({
  status: 'open', pricesAndImpliedProbabilities: true, limit: 50,
});

for (const p of PLAN) {
  const m = markets.find((x) => (x.metadata?.question ?? '').includes(p.ara));
  if (!m) { console.log(`BULUNAMADI: ${p.ara}\n`); continue; }

  const outcomes = m.metadata.outcomes;
  const idx = outcomes.findIndex((o) => o === p.sonuc);
  const ekran = m.spotImpliedProbabilities?.[idx];

  console.log(m.metadata.question);
  console.log(`   alinacak: ${p.sonuc} (indeks ${idx})   ekran fiyati: ${(ekran * 100).toFixed(1)}%`);

  // Walk up until the cost passes the budget, then report the last one under it.
  let best = null;
  for (const shares of [100, 200, 300, 400, 500, 600, 700, 800, 1000, 1250, 1500]) {
    let tokensIn;
    try {
      ({ tokensIn } = await client.quoteBuy({
        marketAddress: m.id, outcomeIdx: idx, sharesOut: BigInt(shares) * SHARE,
      }));
    } catch (e) { console.log(`   ${shares} hisse: teklif alinamadi, ${e.message.slice(0, 60)}`); break; }

    const cost = toTst(tokensIn);
    if (cost > p.butce) break;
    best = { shares, cost, avg: cost / shares };
  }

  if (!best) console.log('   butce bir hisseye bile yetmiyor');
  else {
    const kar = best.shares - best.cost;
    console.log(`   ${best.shares} hisse = ${best.cost.toFixed(1)} TST`);
    console.log(`   gercek ortalama fiyat: ${(best.avg * 100).toFixed(1)}%  (ekrandan ${((best.avg - ekran) * 100).toFixed(1)} puan kotu)`);
    console.log(`   dogru cikarsa: +${kar.toFixed(1)} TST   yanlis cikarsa: -${best.cost.toFixed(1)} TST`);
  }
  console.log();
}
