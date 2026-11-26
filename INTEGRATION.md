# Integration Guide

This guide uses only HashKey Chain Testnet (chain ID 133). The addresses in `.env.example` are derived from the Blockscout evidence summarized in [DISCOVERY.md](DISCOVERY.md). The HSKSwap frontend is currently jurisdiction-blocked, so the factory/router/token association is the strongest on-chain candidate set found, not a proven frontend configuration.

## 1. Fund a fresh wallet

Use the testnet faucet at <https://faucet.hskchain.net/faucet> and complete its human reCAPTCHA if the wallet needs funding. The observed drip is 0.1 HSK. This run started with 0.099699775767 HSK and ended with 0.089204694061578573 HSK on chain ID 133.

The built-in bootstrap uses `0.01 HSK` to mint WHSK through the verified `WHSK.deposit()` function, then swaps WHSK to TT1 through the factory's fee-3000 pool. Keep `0.02 HSK` for gas. Measured fees were `0.000300 HSK` for the one-off deployment and `0.000036–0.000142 HSK` per routine transaction, so a `0.1 HSK` drip leaves room for the reserve and trading. The read-only QuoterV2 call returned `0.172180703260754993 TT1` for `0.01 WHSK` at the earlier observed pool state; actual output can differ and the swap enforces the configured 100 bps minimum-output bound.

## 2. Install and set the key file

Use Node.js 22 or later. The key stays in a separate local file and must never be committed:

```sh
npm ci
chmod 600 /absolute/path/to/key-file.json
export HSK_AGENT_KEY_FILE=/absolute/path/to/key-file.json
```

The file may contain raw `0x`-prefixed 32-byte hex or JSON shaped like `{"privateKey":"0x..."}`. The agent derives the wallet address at runtime. It does not print or log the key. No paid API key is used; the RPC is `https://testnet.hsk.xyz`.

Optional settings can be exported from `.env.example` after replacing the key path:

```sh
cp .env.example .env
# Edit HSK_AGENT_KEY_FILE in .env.
set -a
. ./.env
set +a
```

The configuration is pinned to chain ID `133`. Every transaction path independently checks `eth_chainId` and refuses any other chain.

## 3. Verify the deployment and quote path

Run the offline math checks, type check, and read-only network preflight:

```sh
npm test
npm run check
npm run preflight
```

Preflight verifies bytecode, factory `getPool` results, pool token order and fee, active liquidity, `slot0`, QuoterV2 outputs, and wallet balances. It also reads the WHSK/TT1 bootstrap pool's runtime `slot0`, reports the gas conversion, and previews the fee-aware rebalance plan with six constraints. It does not send transactions, append ledger records, or save state.

Expected results: `npm test` reports all tests passing (26 tests, including all 11 original tests, 0 failures) and `npm run check` (`tsc --noEmit`) exits silently with code 0. `npm run preflight` prints a JSON object whose first fields are `"status": "read_only_preflight"` and `"chainId": 133`, with a nonzero pool `liquidity`, a nonzero `quotes.token1OutFromWhsk`, a `gasFloor` object, a `rebalance.constraints` preview, and a `balances` object for the signer wallet. A thrown error, a zero quote, or a missing contract code means the path is not reproducible as configured. The selected pair is TT2 `0x0284eA6081C90fd5a48BCCc324C7bE1e46ea8cDb` / TT1 `0xC383e13C47112b76be60f41ef5E5d8f9A8E75aE5`, fee `3000`, pool `0xf826C65abDFF3B817e846DB4dfB68107CEFeB6b5`. The bootstrap pair is WHSK `0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6` / TT1, fee `3000`, pool `0x9fCdf0d609B36e2C8F8a194BeD2583c772d6EF76`.

The pool and token contracts are on-chain candidates; their association with the official HSKSwap frontend could not be checked because the app origin returned an access-restriction page. The two token addresses supplied as initial leads are not pooled and are intentionally not used.

## 4. Use the decision log

`AgentDecisionLog` is already deployed on testnet; do not redeploy it. Its address is `0xfb3e5F2d31A1a473CC09C847A4B564C0c2C46FD1` and its successful deployment transaction is [`0x4fe2bd18ee9eb9c60f93b7fcc6fdcb28a5fb520816508206e3c92bc138283d85`](https://testnet-explorer.hskchain.net/tx/0x4fe2bd18ee9eb9c60f93b7fcc6fdcb28a5fb520816508206e3c92bc138283d85). `.env.example` has this address in `HSK_DECISION_LOG_ADDRESS`, so a fresh checkout can use the existing registry without local ignored runtime metadata. `npm run deploy` is reserved for an explicitly separate registry.

## 5. Run the autonomous loop

Start the monitor:

```sh
npm run run
```

With no TT1/TT2 balance, the agent checks the WHSK/TT1 quote, enforces its input and position caps, wraps `0.01 HSK`, and submits a Router02 `exactInputSingle`. After at least 300 seconds, the rebalance signal evaluates the TT1/TT2 allocation and may buy or sell based on the 50% target and 500 bps band. Every swap uses a QuoterV2 estimate and at least 99% of that estimate as `amountOutMinimum`.

Each poll appends prices, balances, signal, plan reason, all risk checks, and result to `logs/decisions.jsonl`. Each successful swap is followed by a `DecisionLogged` event that includes the swap hash. The six rebalance guards are:

| Constraint | Default |
| --- | --- |
| `max_trade_size` | 0.1 token input |
| `max_position_size` | 2 TT1 target position for buys |
| `slippage_cap` | 100 bps configured; independent hard ceiling 1,000 bps |
| `min_trade_interval` | 300 seconds |
| `daily_loss_halt` | 500 bps / 5% marked daily loss |
| `gas_floor` | Input value (TT1) ≥ `2 × estimated gas cost (TT1)` |

### Gas floor and configuration

For a rebalance swap, `inputValueTT1 = amountIn × main slot0 price` when spending TT2, or `amountIn` when spending TT1. The comparison uses the planned input **after** inventory and trade-size caps. Gas cost is `estimatedGasHsk × runtime bootstrap slot0 price (TT1/WHSK)` because HSK≈WHSK 1:1. `readSnapshot` carries the bootstrap price and accounts for its token order; the price is never hardcoded. Input below `minGasMultiple × gasCostTT1` is `risk_blocked`; equality passes. The sixth ledger constraint is `{name: "gas_floor", detail, passed}`, and its detail records input value, estimated gas cost, multiple, and threshold in raw TT1 units. **Bootstrap is exempt** and retains the five existing guards; HOLD passes this check.

Set `HSK_MIN_GAS_MULTIPLE=2` (integer 1–1,000) and `HSK_ESTIMATED_GAS_HSK=0.00015` (positive decimal ≤1 HSK, up to 18 decimals). Invalid values fail configuration loading. The 0.00015 HSK default exceeds the measured maximum routine transaction cost of 0.000142 HSK. This estimate is separate from the 0.02 HSK wallet reserve.

Design basis: a measured single transaction of **0.000120 HSK** cost **0.002070 TT1**. At **20×**, the threshold is **0.041 TT1**, above the current portfolio's **0.008598 TT1** band-edge gap, stretching the effective band from **500 to 2,407 bps** and essentially stopping the strategy. At **2×**, the threshold is **0.00414 TT1**, filtering orders below half the band. Those example thresholds use measured gas; the conservative 0.00015 HSK default and live price determine the runtime threshold.

### Fee-aware planning

Planning uses the main pool's configured fee (`HSK_POOL_FEE=3000`, or 30 bps; shared fee denominator 1,000,000). With total TT1 value `T`, TT1 balance `b`, target fraction `t`, fee fraction `f`, and price `p` in TT1/TT2, a buy uses `amountIn(TT2)=(tT-b)/[p(1-(1-t)f)]`, while a sell uses `amountIn(TT1)=(b-tT)/(1-tf)`. Both account for the post-fill total value `T-fx`, where `x` is input value in TT1. At `t=0.5`, both use `1-f/2`; merely dividing the old input by `1-f` would ignore the decrease in total value. Caps and final integer rounding still apply. With an uncapped fill at a linear price minus fee, the expected TT1 weight returns to **5,000 bps**.

The old linear extrapolation differed from the measured fill by **33.5 bps ≈ 30 bps fee + 3.5 bps curvature**, leaving a **5,006 bps** weight (**6 bps** residual). This enhancement corrects the modeled fee effect; QuoterV2 and minimum-output protection still handle the actual execution quote, including curvature.

### 考虑过但未采用的增强（附实测理由）

- **池 TWAP**: Main-pool `observationCardinality=1`; `observe` means for all six tested windows equal current tick **-11055**. TWAP is spot until observation cardinality is expanded and history accumulates. Those prerequisites are unmet; deferred.
- **滞回带**: The verified ledger's post-fill weight was **5,006 bps**, followed by **9 rounds** of HOLD at **6 bps** deviation. No band-edge oscillation sample exists, so marginal value is zero. Reassess when oscillation samples appear.
- **流动性份额上限**: **1%** of pool value equals **4.89 TT1** and would never trigger for this portfolio; the existing **0.1** cap occupies only **2.05 bps** of pool value. This decorative check is omitted.
- **双池交叉校验**: The fee-500 and main pools show a structural basis of **18,223 bps** (**0.9344 vs 0.3311**). Any usable threshold would permanently block trading; omitted.

Stop the loop with Ctrl+C. Inspect on-chain decision events with:

```sh
npm run audit
```

Expected results: the loop's first line is a JSON object with `"status": "agent_started"`, the wallet address, and the decision log address; each cycle then prints one JSON line (cycle statuses include `no_trade`, `risk_blocked`, and `success`). `npm run audit` prints an `eventCount` and the matching events; for the verified deployment it reports 2 events whose `swapTxHash` values equal the two swap transaction hashes in section 7.

## 6. View the ledger

In another terminal, serve the dashboard:

```sh
npm run dashboard
```

Open <http://127.0.0.1:4173>. The dashboard reads the live `logs/decisions.jsonl` file through `GET /logs/decisions.jsonl`, shows the latest positions and price, and links swaps, approvals, and decision-log transactions to the testnet explorer.

## 7. Verified live session

The 2026-11-26 run completed a bootstrap cycle and 12 further autonomous cycles on testnet. It wrapped HSK, bootstrapped TT1, waited for the 300-second trade interval, sold TT1 into TT2, and then held once the allocation returned inside the configured band. All listed transactions have successful receipts, and `npm run audit` found two DecisionLogged events with swap hashes matching the router transactions.

**This verified session (17 ledger records, two swaps) ran the strategy before the enhancements.** The enhanced version is covered by unit tests and read-only preflight/audit; it has not performed a new live swap. Enhancement verification on 2026-11-26 passed 26/26 tests and `tsc --noEmit`; at block **36250674**, preflight returned the exact final balances below and six passing HOLD-preview checks, and audit returned the same two matching events. No trading loop or ledger-writing observation was run, and the historical 17-record ledger was preserved.

| Step | Outcome | Explorer transaction |
| --- | --- | --- |
| Wrap 0.01 HSK to WHSK | Success, block 36242450 | [`0x53df2e8c69503170e6f96fa1c3b158fb4629a75d72167e08bd2c7667306263cc`](https://testnet-explorer.hskchain.net/tx/0x53df2e8c69503170e6f96fa1c3b158fb4629a75d72167e08bd2c7667306263cc) |
| Approve WHSK to router | Success, block 36242454 | [`0xbd4506e9e8ec1ef56a64e0f30e3468b6d37cdc9e65d07ad3813e919e2512d9fa`](https://testnet-explorer.hskchain.net/tx/0xbd4506e9e8ec1ef56a64e0f30e3468b6d37cdc9e65d07ad3813e919e2512d9fa) |
| Bootstrap: 0.01 WHSK → 0.172180703260754993 TT1 | Success; no inventory triggered the seed buy | [`0xb98e2e6b039342a364113aebaa1ebe656af8573344d1d70e76516964fb717d92`](https://testnet-explorer.hskchain.net/tx/0xb98e2e6b039342a364113aebaa1ebe656af8573344d1d70e76516964fb717d92) |
| Bootstrap DecisionLogged event | Success, block 36242460 | [`0x9a17d7b4c9e8a2db457cc50e0a905f9ebe713404cb3ec26b3c454dda8cf8598f`](https://testnet-explorer.hskchain.net/tx/0x9a17d7b4c9e8a2db457cc50e0a905f9ebe713404cb3ec26b3c454dda8cf8598f) |
| Approve TT1 to router | Success, block 36242620 | [`0x06f21d08be3be649507105b8e89b7f4039394864af5a6e9fb149e4d8c88ef574`](https://testnet-explorer.hskchain.net/tx/0x06f21d08be3be649507105b8e89b7f4039394864af5a6e9fb149e4d8c88ef574) |
| Rebalance: 0.086090351630377497 TT1 → 0.259328888119975221 TT2 | Success; TT1 at 100% of portfolio value (5,000 bps above the 50% target) prompted the sale; settled at 50.06% of portfolio value (5,006 bps weight) | [`0x67df0cc6e2013ef7981402c7b8d93e85b0aff7064abe439c0feddef5e17815c4`](https://testnet-explorer.hskchain.net/tx/0x67df0cc6e2013ef7981402c7b8d93e85b0aff7064abe439c0feddef5e17815c4) |
| Rebalance DecisionLogged event | Success, block 36242627 | [`0xd08e89bc145dad6378f01f62b671a76cf0a5059ddb5c30076a38d6760b180131`](https://testnet-explorer.hskchain.net/tx/0xd08e89bc145dad6378f01f62b671a76cf0a5059ddb5c30076a38d6760b180131) |

Final on-chain balances at block 36242807: **0.089204694061578573 HSK**, **0 WHSK**, **0.259328888119975221 TT2**, and **0.086090351630377496 TT1**. At the last agent observation the portfolio value was 0.171952583404081495 TT1, with TT1 at 5,006 bps of portfolio value. All 17 JSONL records remain in `logs/decisions.jsonl`: 3 pre-funding observation records, the wrap record, and 13 funded-session decision records (the bootstrap buy, 4 sell plans of which 3 were held by the 300-second minimum interval and 1 executed, and 8 in-band holds).

## Keys and reproducibility

This build uses no hosted LLM, paid market-data provider, or private RPC API key, so there are no third-party API keys to submit with it; the decision engine is a deterministic on-chain strategy whose inputs, guards, and outputs are all reproducible from the JSONL ledger. The only secret is each operator's own signer file, supplied through `HSK_AGENT_KEY_FILE`; it is not copied into the repository or included in logs. All other values, including addresses, fees, trade caps, timing, and slippage, are listed in `.env.example` and have evidence summarized in [DISCOVERY.md](DISCOVERY.md).

The complete JSONL decision history, including the two earlier no-funds bootstrap holds, is preserved in `logs/decisions.jsonl` and served directly by the dashboard. The signer key remains outside the repository.
