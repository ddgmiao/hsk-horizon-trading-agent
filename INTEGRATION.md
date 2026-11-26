# Integration Guide

This guide uses only HashKey Chain Testnet (chain ID 133). The addresses in `.env.example` are derived from the Blockscout evidence summarized in [DISCOVERY.md](DISCOVERY.md). The HSKSwap frontend is currently jurisdiction-blocked, so the factory/router/token association is the strongest on-chain candidate set found, not a proven frontend configuration.

## Read-only audit from a fresh checkout

From the repository root with Node.js 22 or later, run

```sh
npm ci
npm run audit
```

The audit needs only the public RPC. It reads the registry address, deployment block **36242135**, and agent **`0x3ebc1896581bc0566A21903cC64Ed7e66F62284e`** from `deployment/registry.json`. It queries the permissionless registry with the indexed agent address in windows of 1,000 blocks. For the published session, expect `eventCount: 2` and the two swap hashes in section 7, at registry event blocks **36242460** and **36242627**. Local metadata for this registry must agree with the published deployment block. A different registry needs its own deployment block and is scanned without a wallet filter; the result reports `agent: null` and the effective `fromBlock`.

## 1. Fund a fresh wallet

Use the testnet faucet at <https://faucet.hskchain.net/faucet> and complete its human reCAPTCHA if the wallet needs funding. The observed drip is 0.1 HSK. This run started with 0.099699775767 HSK and ended with 0.089204694061578573 HSK on chain ID 133.

The built-in bootstrap uses `0.01 HSK` to mint WHSK through the verified `WHSK.deposit()` function, then swaps WHSK to TT1 through the factory's fee-3000 pool. Keep `0.02 HSK` for gas. Measured fees were `0.000300 HSK` for the one-off deployment and `0.000036–0.000142 HSK` per routine transaction, so a `0.1 HSK` drip leaves room for the reserve and trading. The read-only QuoterV2 call returned `0.172180703260754993 TT1` for `0.01 WHSK` at the earlier observed pool state; actual output can differ and the swap enforces the configured 100 bps minimum-output bound.

## 2. Install and set the key file

Use Node.js 22 or later, with Linux `flock` (util-linux) for trading and observation. The key stays in a separate local file and must never be committed:

```sh
npm ci
chmod 600 /absolute/path/to/key-file.json
export HSK_AGENT_KEY_FILE=/absolute/path/to/key-file.json
```

The file may contain raw `0x`-prefixed 32-byte hex or JSON shaped like `{"privateKey":"0x..."}`. The agent derives the wallet address at runtime. It does not print or log the key. No paid API key is used; the RPC is `https://testnet.hsk.xyz`.

For trading, export `HSK_AGENT_KEY_FILE` and, on a fresh checkout, `HSK_DECISION_LOG_ADDRESS`. A local deployment file can supply the latter. Load the example values after editing the key path.

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

Preflight verifies bytecode, factory `getPool` results, pool token order and fee, active liquidity, `slot0`, QuoterV2 outputs, and wallet balances. It also reads the WHSK/TT1 bootstrap pool's runtime `slot0`, reports the gas conversion, and previews the fee-aware rebalance plan with the six strategy constraints plus quote and liquidity checks. It does not send transactions, append ledger records, or save state.

`npm test` should pass the original 26 tests and the audit, dashboard, and execution regression tests. `npm run check` (`tsc --noEmit`) exits silently with code 0. `npm run preflight` prints a JSON object whose first fields are `"status": "read_only_preflight"` and `"chainId": 133`, with a nonzero pool `liquidity`, a nonzero `quotes.token1OutFromWhsk`, a `gasFloor` object, a `rebalance.constraints` preview, and a `balances` object for the signer wallet. A thrown error, a zero quote, or a missing contract code means the path is not reproducible as configured. The selected pair is TT2 `0x0284eA6081C90fd5a48BCCc324C7bE1e46ea8cDb` / TT1 `0xC383e13C47112b76be60f41ef5E5d8f9A8E75aE5`, fee `3000`, pool `0xf826C65abDFF3B817e846DB4dfB68107CEFeB6b5`. The bootstrap pair is WHSK `0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6` / TT1, fee `3000`, pool `0x9fCdf0d609B36e2C8F8a194BeD2583c772d6EF76`.

The pool and token contracts are on-chain candidates; their association with the official HSKSwap frontend could not be checked because the app origin returned an access-restriction page. The two token addresses supplied as initial leads are not pooled and are intentionally not used.

## 4. Use the decision log

`AgentDecisionLog` is already deployed on testnet; do not redeploy it. Its address is `0xfb3e5F2d31A1a473CC09C847A4B564C0c2C46FD1` and its successful deployment transaction is [`0x4fe2bd18ee9eb9c60f93b7fcc6fdcb28a5fb520816508206e3c92bc138283d85`](https://testnet-explorer.hskchain.net/tx/0x4fe2bd18ee9eb9c60f93b7fcc6fdcb28a5fb520816508206e3c92bc138283d85). `.env.example` has this address in `HSK_DECISION_LOG_ADDRESS`, so a fresh checkout can use the existing registry without local ignored runtime metadata. `npm run deploy` is reserved for an explicitly separate registry.

## 5. Run the autonomous loop

Start the monitor:

```sh
npm run run
```

For an unprovisioned wallet with marked TT1/TT2 value below `HSK_MIN_TRADABLE_NOTIONAL_QUOTE=0.01` TT1 (including dust), the agent checks the WHSK/TT1 quote and input cap, wraps up to `0.01 HSK`, and rechecks existing TT1 plus the seed quote against its TT1 position cap on the quote used for Router02 `exactInputSingle`. Before each wrap, approval, swap, and registry write, it checks that the pending native balance covers the transaction value, the signed gas limit at its fee cap, the current L1 data-fee bound, the operator fee at the gas limit, and the configured reserve. After at least 300 seconds, the rebalance signal evaluates the TT1/TT2 allocation and may buy or sell based on the 50% target and 500 bps band. At 100 bps slippage, `amountOutMinimum` is the larger of 99% of the pinned QuoterV2 quote and 99% of the fee-adjusted decision-block spot output, each rounded up to an output base unit. A quote already below the spot minimum is blocked. Dust eligibility is recorded with its threshold and never applies to an already provisioned wallet.

Each poll appends the decision block number/hash, pinned prices and balances, effective policy (including reserve, target, band and slippage), separate `observedAt`/`quoteAt`/`fillAt` timestamps, signal, plan reason, all risk checks, and result to `logs/decisions.jsonl`. For a mined swap, the agent reads the wallet-to-pool and pool-to-wallet transfers from the receipt. It also checks the routed pool’s Swap event, which can supply an amount if a transfer log is absent. It flags input different from the signed amount or output below the minimum. It journals the swap hash before broadcast and saves the confirmed cooldown before registry or balance reads. A restart reconciles the saved hash before another trade. If confirmation is unavailable, the hash stays pending. A registry failure is recorded alongside the local fill.

Overlapping polls in one process share one cycle. Every cycle, bootstrap, and observation holds the state directory's `.agent.lock` through decision and settlement; separate processes wait on the same kernel lock. The kernel releases it when the owner exits, including a crash, so an abandoned file needs no deletion. Keep processes sharing a wallet on the same state directory, and never delete or replace a live lock file.

After approval, a fresh pinned snapshot, quote and plan must pass every guard before swap submission; HOLD or a failed guard ends the cycle with the approval hash and outcome recorded. An unchanged input keeps the original minimum when it is stricter.

Recovery runs before market verification. The registry uses signal `observedAt`; the legacy `timestamp` remains a fill-time alias for completed swaps. Fill timestamps and cooldowns use the receipt's block timestamp. The registry journal saves all nine `record()` arguments and its signed envelope before broadcast. If a saved hash has no receipt after a five-second wait, recovery rebuilds the call and rebroadcasts the identical envelope and nonce, then waits for confirmation. A recovered bootstrap refreshes its daily-loss baseline from observed post-fill holdings; a failed balance read leaves a durable baseline-refresh flag that blocks another trade until resolved. A corrupt final JSONL line is skipped with a warning, and only that damaged tail is removed before the next append; corruption in any earlier line fails closed.

The six rebalance guards are listed below.

| Constraint | Default |
| --- | --- |
| `max_trade_size` | 0.1 token input |
| `max_position_size` | 2 TT1 target position for buys |
| `slippage_cap` | 100 bps configured; independent hard ceiling 1,000 bps |
| `min_trade_interval` | 300 seconds |
| `daily_loss_halt` | 500 bps / 5% marked daily loss |
| `gas_floor` | Allocation error removed (TT1) ≥ `2 × expected whole-path cost (TT1)` |

### Gas floor and configuration

For a rebalance, project post-trade holdings using the capped planned input and pinned execution quote at unchanged marks. Require `D_before - D_after >= minGasMultiple × pathCostHSK × TT1/WHSK`, where `D = abs(TT1 balance - target fraction × portfolio value)`. Target arithmetic stays exact through the comparison; constraint details record errors scaled by 10,000. Path cost includes swap and DecisionLog registry write gas, plus approval gas only when the pinned allowance is insufficient. HOLD passes; bootstrap is exempt. Execution also checks pinned liquidity and the spot minimum.

Set `HSK_MIN_GAS_MULTIPLE=2`, swap estimate `HSK_ESTIMATED_GAS_HSK=0.00015`, approval estimate `HSK_ESTIMATED_APPROVAL_GAS_HSK=0.000046321`, and registry estimate `HSK_ESTIMATED_REGISTRY_GAS_HSK=0.000035773`. Gas estimates must be positive decimals up to 1 HSK with at most 18 decimals. They are separate from the 0.02 HSK reserve, whose transaction checks use signed fee bounds.

The measured path is 0.000223896 HSK, including swap 0.000141802, approval 0.000046321 and registry 0.000035773 HSK. At 17.24617 TT1/WHSK, 2× costs about 0.007723 TT1; default estimates cost about 0.008005 TT1 including approval. Both remain below the 0.008598 TT1 band-edge gap. The historical sell still passes. Band eligibility compares `abs(10000 × TT1 balance - targetBps × totalValue) > bandBps × totalValue`, with integer bps reserved for display.

### Fee-aware planning

Planning uses the main pool's configured fee (`HSK_POOL_FEE=3000`, or 30 bps; shared fee denominator 1,000,000). With total TT1 value `T`, TT1 balance `b`, target fraction `t`, fee fraction `f`, and price `p` in TT1/TT2, a buy uses `amountIn(TT2)=(tT-b)/[p(1-(1-t)f)]`, while a sell uses `amountIn(TT1)=(b-tT)/(1-tf)`. Both account for the post-fill total value `T-fx`, where `x` is input value in TT1. At `t=0.5`, both use `1-f/2`; merely dividing the old input by `1-f` would ignore the decrease in total value. Caps and final integer rounding still apply. With an uncapped fill at a linear price minus fee, the expected TT1 weight returns to **5,000 bps**.

The old linear extrapolation differed from the measured fill by **33.5 bps ≈ 30 bps fee + 3.5 bps curvature**, leaving a **5,006 bps** weight (**6 bps** residual). This enhancement corrects the modeled fee effect; QuoterV2 and minimum-output protection still handle the actual execution quote, including curvature.

### 考虑过但未采用的增强（附实测理由）

- **池 TWAP**: Main-pool `observationCardinality=1`; `observe` means for all six tested windows equal current tick **-11055**. TWAP is spot until observation cardinality is expanded and history accumulates. Those prerequisites are unmet; deferred.
- **滞回带**: The verified ledger's post-fill weight was **5,006 bps**, followed by **8 rounds** of HOLD at **6 bps** deviation. No band-edge oscillation sample exists, so marginal value is zero. Reassess when oscillation samples appear.
- **流动性份额上限**: **1%** of pool value equals **4.89 TT1** and would never trigger for this portfolio; the existing **0.1** cap occupies only **2.05 bps** of pool value. This decorative check is omitted.
- **双池交叉校验**: The fee-500 and main pools show a structural basis of **18,223 bps** (**0.9344 vs 0.3311**). Any usable threshold would permanently block trading; omitted.

Stop the loop with Ctrl+C. Its first line identifies the wallet and registry. Each cycle prints its decision, including `no_trade`, `risk_blocked`, or `success`. The independent read-only audit command is at the top of this guide.

## 6. View the ledger

In another terminal, serve the dashboard:

```sh
npm run dashboard
```

Open <http://127.0.0.1:4173>. The dashboard reads the live `logs/decisions.jsonl` file through `GET /logs/decisions.jsonl`, shows the latest positions and price, and links swaps, approvals, and decision-log transactions to the testnet explorer.

## 7. Verified live session

The 2026-11-26 run completed a bootstrap cycle and 12 further autonomous cycles on testnet. It wrapped HSK, bootstrapped TT1, waited for the 300-second trade interval, sold TT1 into TT2, and then held once the allocation returned inside the configured band. All listed transactions have successful receipts, and `npm run audit` found two DecisionLogged events with swap hashes matching the router transactions.

**This verified session (17 ledger records, two swaps) ran the strategy before the enhancements.** The optimization round (whole-path economics, pinned snapshots and approval refresh, dust provisioning, spot-anchored minima, and both rounding fixes) is a post-run improvement, NOT part of the live-run code. It was verified offline without new live transactions. The enhanced version is covered by unit tests and read-only preflight/audit; it has not performed a new live swap. Enhancement verification on 2026-11-26 passed 26/26 tests and `tsc --noEmit`; at block **36250674**, preflight returned the exact final balances below and six passing HOLD-preview checks, and audit returned the same two matching events. No trading loop or ledger-writing observation was run, and the historical 17-record ledger was preserved.

| Step | Outcome | Explorer transaction |
| --- | --- | --- |
| Wrap 0.01 HSK to WHSK | Success, block 36242450 | [`0x53df2e8c69503170e6f96fa1c3b158fb4629a75d72167e08bd2c7667306263cc`](https://testnet-explorer.hskchain.net/tx/0x53df2e8c69503170e6f96fa1c3b158fb4629a75d72167e08bd2c7667306263cc) |
| Approve WHSK to router | Success, block 36242454 | [`0xbd4506e9e8ec1ef56a64e0f30e3468b6d37cdc9e65d07ad3813e919e2512d9fa`](https://testnet-explorer.hskchain.net/tx/0xbd4506e9e8ec1ef56a64e0f30e3468b6d37cdc9e65d07ad3813e919e2512d9fa) |
| Bootstrap: 0.01 WHSK → 0.172180703260754993 TT1 | Success; no inventory triggered the seed buy | [`0xb98e2e6b039342a364113aebaa1ebe656af8573344d1d70e76516964fb717d92`](https://testnet-explorer.hskchain.net/tx/0xb98e2e6b039342a364113aebaa1ebe656af8573344d1d70e76516964fb717d92) |
| Bootstrap DecisionLogged event | Success, block 36242460 | [`0x9a17d7b4c9e8a2db457cc50e0a905f9ebe713404cb3ec26b3c454dda8cf8598f`](https://testnet-explorer.hskchain.net/tx/0x9a17d7b4c9e8a2db457cc50e0a905f9ebe713404cb3ec26b3c454dda8cf8598f) |
| Approve TT1 to router | Success, block 36242620 | [`0x06f21d08be3be649507105b8e89b7f4039394864af5a6e9fb149e4d8c88ef574`](https://testnet-explorer.hskchain.net/tx/0x06f21d08be3be649507105b8e89b7f4039394864af5a6e9fb149e4d8c88ef574) |
| Rebalance: 0.086090351630377497 TT1 → 0.259328888119975221 TT2 | Success; TT1 at 100% of portfolio value (5,000 bps above the 50% target) prompted the sale; settled at 50.06% of portfolio value (5,006 bps weight) | [`0x67df0cc6e2013ef7981402c7b8d93e85b0aff7064abe439c0feddef5e17815c4`](https://testnet-explorer.hskchain.net/tx/0x67df0cc6e2013ef7981402c7b8d93e85b0aff7064abe439c0feddef5e17815c4) |
| Rebalance DecisionLogged event | Success, block 36242627 | [`0xd08e89bc145dad6378f01f62b671a76cf0a5059ddb5c30076a38d6760b180131`](https://testnet-explorer.hskchain.net/tx/0xd08e89bc145dad6378f01f62b671a76cf0a5059ddb5c30076a38d6760b180131) |

Final on-chain balances at block 36242807: **0.089204694061578573 HSK**, **0 WHSK**, **0.259328888119975221 TT2**, and **0.086090351630377496 TT1**. At the last agent observation the portfolio value was 0.171952583404081495 TT1, with TT1 at 5,006 bps of portfolio value. The 17 JSONL records start with two pre-funding rows. Row 3 records a reserve-blocked bootstrap at block 36242151, when the wallet already held 0.099699775767259497 HSK following the funding transaction at block 36242016. The wrap and bootstrap buy follow, then four sell plans (three interval-blocked, one executed) and eight in-band HOLDs on lines 10–17. [Funding transaction](https://testnet-explorer.hskchain.net/tx/0x00c8f424713cced004055bbcd62735cb951cee330cce316f7b931b8189791927)

In the bootstrap buy on line 5, `addresses.pool` identifies the main TT2/TT1 observation pool. The swap receipt identifies the execution pool as WHSK/TT1 at `0x9fCdf0d609B36e2C8F8a194BeD2583c772d6EF76`. [Bootstrap receipt](https://testnet-explorer.hskchain.net/tx/0xb98e2e6b039342a364113aebaa1ebe656af8573344d1d70e76516964fb717d92)

## Keys and reproducibility

The strategy reads prices, pool state, and asset balances from the public RPC. The clock, configuration, and persisted cooldown and daily-loss baselines are local inputs. The ledger shows sampled inputs and guard results. New decision snapshots fetch the block first and pin pool, balance, allowance and quote calls to its block tag; records include the block hash. Historical snapshot RPC calls used unpinned `latest` and sampled the block number separately. The historical bootstrap holds also omit the native balance. Exact replay requires these additional inputs. The verified fills can be checked independently against their receipts.

State is bound to the signer. To retain an existing pre-upgrade state, verify its owner against the wallet’s ledger and receipts, then add the checksummed `wallet` address and `"pendingSwap": null` after accounting for any outstanding swap. Keep the existing cooldown, UTC day, baseline, and bootstrap flag. A submitted hash with an unknown receipt remains pending until reconciled.

Every trading entry cross-checks the bound state against this wallet's ledger fills and keeps the later cooldown. A set daily-loss baseline must be a positive integer in raw TT1 units; zero is rejected. Older registry journals that already saved a hash without its signed envelope can still complete from a mined receipt, but an absent receipt requires manual reconciliation because an identical retry cannot be reconstructed safely.

The only secret is the operator’s signer file, supplied through `HSK_AGENT_KEY_FILE`. The keyless audit uses the same public RPC. Configuration defaults are in `.env.example`. [Discovery evidence](DISCOVERY.md)
