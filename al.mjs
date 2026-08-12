/**
 * Takes the positions the research supports. This one signs.
 *
 * Every buy is quoted first and sent with a ceiling on what it may cost, so a
 * price that moves between the quote and the block cannot turn a measured
 * position into a worse one. LMSR moves against the buyer as the order fills,
 * which is already in the quote; the ceiling is for what happens after.
 *
 * Shares carry 18 decimals and the collateral carries 6. The first version of
 * the quote script divided both by 1e18 and reported that 1500 shares were
 * free, which is the kind of reading that gets acted on at speed. The token's
 * own decimals are read here rather than assumed.
 */
import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

const client = new DelphiClient();
const SHARE = 10n ** 18n;
const { decimals: DEC } = await client.getErc20BalanceWithDecimals();
const toTst = (raw) => Number(raw) / 10 ** DEC;

/** What to buy, why, and how much. Sized so no single wrong call is fatal. */
const PLAN = [
  { ara: 'Arctic sea ice', sonuc: 'Yes', hisse: 400,
    neden: '11 Agu degeri 5.829, esik 5.88, zaten altinda' },
  { ara: 'CRS-35', sonuc: 'No', hisse: 200,
    neden: 'firlatma takviminde 31 Agustos' },
  { ara: 'sunspot', sonuc: 'Yes', hisse: 200,
    neden: 'SILSO 12 Agu tahmini 74, esik 40' },
];

/// How much worse than the quote a fill may be before it is refused.
const KAYMA = 1.02;

const { markets } = await client.listMarkets({
  status: 'open', pricesAndImpliedProbabilities: true, limit: 50,
});

let harcanan = 0;
for (const p of PLAN) {
  const m = markets.find((x) => (x.metadata?.question ?? '').includes(p.ara));
  if (!m) { console.log(`ATLANDI, piyasa bulunamadi: ${p.ara}\n`); continue; }

  const idx = m.metadata.outcomes.findIndex((o) => o === p.sonuc);
  if (idx < 0) { console.log(`ATLANDI, sonuc bulunamadi: ${p.sonuc}\n`); continue; }

  const sharesOut = BigInt(p.hisse) * SHARE;
  const { tokensIn } = await client.quoteBuy({ marketAddress: m.id, outcomeIdx: idx, sharesOut });
  const maxTokensIn = (tokensIn * BigInt(Math.round(KAYMA * 100))) / 100n;

  console.log(m.metadata.question);
  console.log(`   ${p.sonuc} x${p.hisse}  teklif ${toTst(tokensIn).toFixed(1)} TST  tavan ${toTst(maxTokensIn).toFixed(1)}`);
  console.log(`   gerekce: ${p.neden}`);

  try {
    // Approves only what this order can cost, not the default unlimited: an
    // allowance outlives the trade, and there is no reason for the gateway to
    // keep standing permission over the whole balance.
    await client.ensureTokenApproval({
      marketAddress: m.id, minimumAmount: maxTokensIn, approveAmount: maxTokensIn,
    });
    const { transactionHash } = await client.buyShares({
      marketAddress: m.id, outcomeIdx: idx, sharesOut, maxTokensIn,
    });
    harcanan += toTst(tokensIn);
    console.log(`   ALINDI  ${transactionHash}\n`);
  } catch (e) {
    console.log(`   ALINAMADI: ${e.message.slice(0, 160)}\n`);
  }
}

const { balance } = await client.getErc20BalanceWithDecimals();
console.log(`harcanan: ~${harcanan.toFixed(1)} TST`);
console.log(`kalan   : ${toTst(balance).toFixed(1)} TST`);
