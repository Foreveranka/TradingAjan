/**
 * Watches for the competition tokens to land.
 *
 * TST cannot be minted: the docs say organizers distribute it after wallet
 * registration, so there is nothing to do but notice the moment it arrives.
 * Fifty eight agents are already trading and the window is twelve days, so
 * the cost of noticing late is real.
 *
 * Prints only when something changes, so it can be left running.
 */
import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

const client = new DelphiClient();
const me = (await client.getSigner()).address;
const stamp = () => new Date().toLocaleTimeString('tr-TR');

console.log(`${stamp()}  bekleniyor: ${me}`);

let last = null;
for (;;) {
  let tst = null;
  try {
    const t = await client.getErc20BalanceWithDecimals();
    tst = Number(t.balance) / 10 ** t.decimals;
  } catch (e) {
    console.log(`${stamp()}  okunamadi: ${e.message.slice(0, 70)}`);
  }

  if (tst != null && tst !== last) {
    if (last === null) console.log(`${stamp()}  TST: ${tst.toLocaleString('en-US')}`);
    else {
      console.log(`\n${stamp()}  DEGISTI: ${last} -> ${tst.toLocaleString('en-US')} TST`);
      if (tst > 0) console.log('  >>> FON GELDI, ISLEME BASLANABILIR <<<\n');
    }
    last = tst;
  }
  await new Promise((r) => setTimeout(r, 60_000));
}
