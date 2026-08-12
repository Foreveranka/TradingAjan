/**
 * What is open, what it costs, and what we are holding.
 *
 * Read only. Nothing here signs anything, so it can be run as often as you
 * like while deciding whether a market is worth taking.
 *
 * The question and the outcome names live under `metadata`, not on the market
 * itself, and prices come from a separate call rather than travelling with the
 * listing. The first version of this file guessed at both and printed a page
 * of `undefined`.
 */
import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

const client = new DelphiClient();
const me = (await client.getSigner()).address;

const pct = (n) => (n == null ? '  ?  ' : `${(Number(n) * 100).toFixed(1)}%`.padStart(6));

console.log('=== CUZDAN ===');
console.log('adres:', me);
console.log('gas  :', Number(await client.getEthBalance(me)) / 1e18, 'ETH');
try {
  // Takes the token address, not the holder. Passing the wallet asks the
  // wallet for its own balanceOf, which is not a contract and answers "0x".
  const t = await client.getErc20BalanceWithDecimals();
  console.log('TST  :', (Number(t.balance) / 10 ** t.decimals).toLocaleString('en-US'));
} catch (e) {
  console.log('TST  : okunamadi,', e.message);
}

// Prices are off by default and cost a multicall, so they have to be asked
// for. Without this flag every outcome reads as unknown, which is what the
// first run printed.
const raw = await client.listMarkets({
  status: 'open',
  pricesAndImpliedProbabilities: true,
  limit: 50,
});
const markets = raw?.markets ?? [];

console.log(`\n=== ACIK PIYASALAR (${markets.length}) ===\n`);
for (const m of markets) {
  const q = m.metadata?.question ?? '(soru yok)';
  const cat = m.metadata?.category ?? '?';
  const outcomes = m.metadata?.outcomes ?? [];
  console.log(`${q}`);
  console.log(`   konu: ${cat}   uzlasma: ${m.settlesAt ?? m.resolvesAt ?? '?'}`);
  outcomes.forEach((name, i) => {
    console.log(`   ${pct(m.spotImpliedProbabilities?.[i])}  ${name}`);
  });
  console.log();
}

console.log('=== ACIK POZISYONLARIMIZ ===');
try {
  const pos = await client.listPositions({ address: me });
  const list = Array.isArray(pos) ? pos : (pos?.positions ?? []);
  console.log(list.length ? JSON.stringify(list, null, 2) : 'yok');
} catch (e) {
  console.log('okunamadi:', e.message);
}
