# TradingAjan

An autonomous agent that trades prediction markets on Gensyn's Delphi, built
for the Agent Arena competition. Entered as **Anka**.

The whole thing rests on one observation, so it is worth stating before any of
the code: **not every question is a guess.**

## The idea

A prediction market pays you for being right, not for being clever.

Most questions on one are opinion. Will a company announce a product, will a
politician do a thing, who wins a match. A crowd guessing is usually priced
about as well as a guess can be priced, and buying into that means paying the
spread to express a hunch.

Some questions are not like that at all. They resolve against a number that a
public institution is going to publish anyway, on a date already known:

- an Arctic sea ice extent, from NSIDC's daily file
- a sunspot count, from SILSO's daily estimate
- a CPI print, from the BLS release
- a launch, from a manifest anyone can read

The answer to those is not predicted. It is **looked up**. And the market
often prices them as though nobody had bothered.

TradingAjan is built to tell the two apart, take the first kind, and leave the
second alone.

## How it decides

1. Read every open market through the Delphi SDK.
2. Match the question against templates it knows how to resolve.
3. For a match, fetch the institution's own file and form an estimate that owes
   nothing to the market's opinion.
4. Compare that estimate to the price. Trade only when the gap is wide enough
   to survive what an LMSR market charges for size.
5. Where it has no better information than the market, **do nothing**. This is
   a rule rather than an omission: paying the spread to express no opinion is
   the fastest way down a P&L leaderboard.

Anything it cannot price is sent to Telegram with its question and price,
because a person reading one sentence often settles in a minute what no amount
of parsing would.

## Why it runs on a server

New markets open with no trades behind them, so their price reflects nothing.
That is the only dependable edge here and it decays within hours as other
agents arrive. Checking by hand is not a strategy, and a laptop that sleeps is
not a watchman. It runs as a systemd service and speaks when there is
something to say.

## Estimating, and one mistake worth keeping

The first version of the ice estimator divided the margin by an arbitrary
width and returned 59% for a threshold the published data had **already
crossed**. Left alone it would have reversed a correct position and paid for
the privilege.

It now measures the distribution of day over day changes from the data itself,
projects with the mean, widens the uncertainty with the square root of the
number of days, and reads the probability off a normal CDF. Nothing exotic;
the point is that the numbers come from observation rather than from a
constant that felt about right.

The lesson generalises: an estimator that disagrees with a fact you already
hold is not being clever, it is broken.

## Decimals, and the other mistake worth keeping

Shares carry 18 decimals. The collateral token carries 6.

Dividing both by `1e18` made a 350 token position display as `0.0`, so the
first quote run reported that 1500 shares were free. That is a reading someone
acts on quickly and regrets slowly. The token's own decimals are now read from
the contract rather than assumed, everywhere.

## Layout

    nobetci.mjs   the watchman: polls, prices, trades, reports. This is the agent.
    anka.mjs      one pass of the same logic, for running by hand
    bak.mjs       read only: open markets, prices, balances, positions
    teklif.mjs    read only: what a position would actually cost, before signing
    al.mjs        opens a fixed list of researched positions
    bulgular.md   research notes, with the sources and the raw numbers

## Running it

    npm install
    cp .env.example .env      # then fill it in
    node bak.mjs              # look around, signs nothing
    node anka.mjs             # one pass, still signs nothing
    node anka.mjs --al        # same pass, allowed to buy
    node nobetci.mjs          # the loop

Every script that can spend money quotes first and sends a ceiling with the
order, so a price that moves between the quote and the block cannot turn a
measured position into a worse one.

## What is not in here

The wallet key and the API key live in `.env`, which is not committed, and in
a wallet file that is not either. Nothing in this repository can move funds on
its own.

## Guards

- one wallet, per the competition rules
- a cap on any single position, whatever the edge looks like
- a cash reserve held back, so a new market never arrives to empty hands
- a minimum gap before acting, because a thin edge is an illusion after fees
- read only by default; buying takes an explicit flag

## Licence

MIT.
