# Horizon 133

Horizon 133 is a deterministic inventory-rebalancing agent for HashKey Chain Testnet. It reads Uniswap V3 `slot0` prices, computes a fee-aware token allocation signal, applies six guards (position, trade size, slippage, interval, daily loss, and gas floor), and sends swaps through the verified SwapRouter02 candidate. It logs decisions as JSON Lines and submits completed fills to an on-chain registry. The ledger records any registry failure alongside the swap hash.

The strategy reads market prices and balances on chain. Its deterministic guards also use local configuration, the clock, and persisted cooldown and daily-loss baselines. The JSONL ledger exposes the sampled values and guard results. Snapshot calls read unpinned `latest`, with the block number sampled separately, so an exact historical replay requires more than the ledger alone. The agent trades directly from its EOA and needs no paid API key or LLM. The permissionless `AgentDecisionLog` contract records completed swaps without taking custody.

## Current status

The strategy enhancements were verified by the original 26-test suite, `tsc --noEmit`, and read-only `preflight`/`audit`. The current suite also exercises receipt recovery, accounting, persistence, fees, the audit, and dashboard rendering. The verified live session below (17 ledger records and two swaps) ran the **strategy before these enhancements**. The enhanced strategy has **not executed a new live swap**. The full historical JSONL decision ledger is preserved in `logs/decisions.jsonl`; the dashboard serves this same file at `/logs/decisions.jsonl`.

The agent checks a **0.02 HSK native reserve** before each wrap, approval, swap, and registry submission. The pending balance must cover the reserve, any HSK being wrapped, gas limit times the signed fee cap, and the chain’s current upper-bound L1 data fee and operator fee at that gas limit. Measured gas for the verified session was **0.000300 HSK** for the one-off contract deployment and **0.000036–0.000142 HSK** for each routine transaction (wrap, approvals, swaps, decision records), so the 0.1 HSK faucet drip still leaves operating funds after reserve. `AgentDecisionLog` is already deployed at `0xfb3e5F2d31A1a473CC09C847A4B564C0c2C46FD1` by transaction [`0x4fe2bd18ee9eb9c60f93b7fcc6fdcb28a5fb520816508206e3c92bc138283d85`](https://testnet-explorer.hskchain.net/tx/0x4fe2bd18ee9eb9c60f93b7fcc6fdcb28a5fb520816508206e3c92bc138283d85); do not redeploy it. The live session started with 0.099699775767 HSK and finished with 0.089204694061578573 HSK.

There is a second discovery limitation: the HSKSwap app origin returned a jurisdiction restriction page, so its frontend could not be inspected. Factory `0x2dC2...`, router `0xa691...`, QuoterV2 `0x73820...`, and the verified `TestToken1`/`TestToken2` pools form the strongest coherent testnet candidate set, but the exact official app-to-address and official-token association could not be proven from accessible evidence. See [DISCOVERY.md](DISCOVERY.md).

## Architecture

```text
HSK Chain Testnet (133)
  main + bootstrap slot0 + balances -> fee-aware signal -> six risk checks -> QuoterV2
                                                   -> SwapRouter02
                                                   -> AgentDecisionLog event
                                                   -> logs/decisions.jsonl -> dashboard
```

- `src/strategy.ts` contains pure allocation, price, and risk math.
- `src/agent.ts` verifies chain ID, factory pool mappings, token order, active liquidity, and quote paths before operating.
- `contracts/AgentDecisionLog.sol` emits an event linking the decision to the swap transaction hash.
- `dashboard/index.html` reads the JSONL ledger through a small local static server.
- `tests/strategy.test.ts` exercises the offline math and risk gates.

The loop targets 50% TT1 by portfolio value, holds inside a 500 bps band, and caps each input at 0.1 token. It caps quote slippage at 100 bps, waits at least 300 seconds between trades, limits a rebalance buy’s target position to 2 TT1, and halts at a 5% daily marked loss. A fresh wallet with no TT1/TT2 can bootstrap by wrapping 0.01 HSK to WHSK and swapping WHSK to TT1 through the on-chain pool. Bootstrap checks both the initial and execution quotes against the 2 TT1 cap. Subsequent polls can rebalance TT1 against TT2 once the cooldown expires.

## Strategy and six risk checks

| Constraint | Rule / default |
| --- | --- |
| `max_trade_size` | Input at most 0.1 token, also limited by available inventory |
| `max_position_size` | A buy's target TT1 position must not exceed 2 TT1 |
| `slippage_cap` | Configured 100 bps; independent absolute ceiling 1,000 bps |
| `min_trade_interval` | At least 300 seconds between trades |
| `daily_loss_halt` | Halt at a marked daily loss of 500 bps (5%) |
| `gas_floor` | Rebalance input value in TT1 must be at least `minGasMultiple × estimatedGasHsk × live TT1/WHSK price` |

`gas_floor` compares the **capped planned input**, valued at the main pool's `slot0` for TT2 input or 1:1 for TT1 input. The gas estimate defaults to **0.00015 HSK**, above the measured maximum routine transaction cost of **0.000142 HSK**. HSK and WHSK are 1:1, and `readSnapshot` reads the configured WHSK/TT1 bootstrap pool's `slot0`, accounting for token order, to convert gas to TT1. The historical rebalance cost 0.000223896385697785 HSK across the approval, swap, and registry write. The economic floor uses the configured per-transaction estimate. `HSK_MIN_GAS_MULTIPLE` defaults to **2** (integer range 1–1,000); `HSK_ESTIMATED_GAS_HSK` accepts a positive decimal up to 1 HSK with at most 18 decimals. Equality passes; a value below the threshold yields `risk_blocked`. The `gas_floor` entry uses the same `name`/`detail`/`passed` format as the other ledger `constraints`, with input value, gas cost, multiple, and threshold in its detail. It passes for HOLD and is **not applied to bootstrap**.

The design uses the measured example **0.000120 HSK ≈ 0.002070 TT1** per transaction. A multiple of 20 would impose a **0.041 TT1** threshold, exceeding the current portfolio's **0.008598 TT1** gap at the band edge and stretching the effective band from **500 bps to 2,407 bps**, essentially stopping rebalancing. A multiple of 2 gives **0.00414 TT1**, filtering meaningless orders below half the band. These are the measured design example; the conservative default estimate of 0.00015 HSK and runtime price determine the actual threshold.

### Fee-aware planning

The main pool fee is read from the configured `poolFee` (`HSK_POOL_FEE=3000`, i.e. 30 bps), with a shared denominator of 1,000,000. Let `T` be current total TT1 value, `b` the TT1 balance, `t` the target fraction, `f` the fee fraction, and `p` the TT1/TT2 price. Under a linear price with fees, buying with TT1 input value `x` leaves TT1 balance `b+(1-f)x` and total value `T-fx`; selling leaves `b-x` and `T-fx`. Solving for the target weight gives:

- Buy TT1: `amountIn(TT2) = (tT-b) / [p × (1-(1-t)f)]`.
- Sell TT1: `amountIn(TT1) = (b-tT) / (1-tf)`.

At the 50% target both denominators include `1-f/2`. Inventory and input caps still apply. An uncapped simulated fill returns to the target up to integer rounding. The measured old linear estimate differed from execution by **33.5 bps ≈ 30 bps fee + 3.5 bps curvature**, leaving weight **5,006 bps**, a **6 bps** residual. Fee-aware planning removes the modeled fee residual; actual curvature and price movement still affect execution, which retains QuoterV2 and the minimum-output bound.

## 考虑过但未采用的增强（附实测理由）

- **池 TWAP**: The main pool has `observationCardinality=1`; `observe` averages across all six tested windows equal the current tick **-11055**. TWAP degenerates to spot. Expanding observation cardinality and accumulating history are prerequisites that have not been met, so this is deferred.
- **滞回带**: The verified ledger settled at **5,006 bps** after execution, and the following **8 rounds** held at **6 bps** deviation. There are no band-edge oscillation samples, so the measured marginal value is zero. Reassess if oscillation samples appear.
- **流动性份额上限**: **1%** of pool value is **4.89 TT1**, which would never trigger for this portfolio; the existing **0.1** input cap is just **2.05 bps** of pool value. This would be a decorative check and is omitted.
- **双池交叉校验**: The fee-500 pool and main pool have a structural basis of **18,223 bps** (**0.9344 vs 0.3311**). Any usable threshold would permanently block operation, so this is omitted.

## Addresses

All addresses below are testnet addresses. The evidence and caveats are in [DISCOVERY.md](DISCOVERY.md).

| Role | Address | Evidence |
| --- | --- | --- |
| RPC | `https://testnet.hsk.xyz` | `eth_chainId` returns `0x85` |
| Explorer | `https://testnet-explorer.hskchain.net` | Blockscout API v2 |
| V3 factory candidate | `0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0` | Verified explorer search; router constructor argument; `getPool` returns the selected pools |
| SwapRouter02 candidate | `0xa6914E66690c6794244B5f66a09eAEbf66254237` | Verified source, factory/WHSK constructor args, successful indexed `exactInputSingle` calls |
| Alternate SwapRouter02 candidate | `0x46cBccE3c74E95d1761435d52B0b9Abc9e2FEAC0` | Verified source; same factory, alternate manager/WHSK args |
| QuoterV2 candidate | `0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC` | Verified source and matching factory/WHSK constructor args; read-only quotes pass |
| TT2 / token0 | `0x0284eA6081C90fd5a48BCCc324C7bE1e46ea8cDb` | Verified `TestToken2`, 18 decimals |
| TT1 / token1 | `0xC383e13C47112b76be60f41ef5E5d8f9A8E75aE5` | Verified `TestToken1`, 18 decimals |
| TT2/TT1 pool, fee 3000 | `0xf826C65abDFF3B817e846DB4dfB68107CEFeB6b5` | Factory `PoolCreated`, nonzero liquidity, `slot0` and Quoter reads |
| TT2/TT1 pool, fee 500 | `0x3A856BaDAB1793c4DB46d6f220f2FF2a853BBDd1` | Factory `getPool`, nonzero liquidity and token balances |
| WHSK | `0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6` | Verified `Wrapped HSK`; matches router and quoter arguments |
| WHSK/TT1 bootstrap pool, fee 3000 | `0x9fCdf0d609B36e2C8F8a194BeD2583c772d6EF76` | Factory `getPool`, nonzero liquidity, successful read-only QuoterV2 quote |
| Position manager dependency of selected router | `0x73dec6bfa6751509b08480bd97f54b874e3b20e8` | Router verified constructor argument; not called directly by this agent |
| Agent wallet | `0x3ebc1896581bc0566A21903cC64Ed7e66F62284e` | Address supplied in the brief; key is read at runtime only |
| AgentDecisionLog | `0xfb3e5F2d31A1a473CC09C847A4B564C0c2C46FD1` | Deployed on testnet; [deployment transaction](https://testnet-explorer.hskchain.net/tx/0x4fe2bd18ee9eb9c60f93b7fcc6fdcb28a5fb520816508206e3c92bc138283d85), successful receipt and runtime code verified |

The brief's token leads, `0xE4577dCF1C44F04cf489AA995E01e988f461cc4A` and `0xcF9bEC9f2769Ecc09107C58fA5eB0199D989A606`, are not used: both are unverified `TestToken1` contracts with no discovered pool between them.

## Reference transactions

The first two transactions are discovery context only, not Horizon 133 entry transactions. The DecisionLog deployment belongs to this entry:

- Pool creation: [`0x45ec2044d7e0afa4fafdddf9134952ca1ca98d6f1e626d9dcdf97d718cabc5d5`](https://testnet-explorer.hskchain.net/tx/0x45ec2044d7e0afa4fafdddf9134952ca1ca98d6f1e626d9dcdf97d718cabc5d5)
- Existing router swap: [`0x1376be84db8cc99b0b5b35b628fba5a07c113e9bd956a55fa27cf880d8ff02ac`](https://testnet-explorer.hskchain.net/tx/0x1376be84db8cc99b0b5b35b628fba5a07c113e9bd956a55fa27cf880d8ff02ac)
- Horizon 133 DecisionLog deploy: [`0x4fe2bd18ee9eb9c60f93b7fcc6fdcb28a5fb520816508206e3c92bc138283d85`](https://testnet-explorer.hskchain.net/tx/0x4fe2bd18ee9eb9c60f93b7fcc6fdcb28a5fb520816508206e3c92bc138283d85)
- The live run and all transaction hashes are recorded in [Verified live testnet session](#verified-live-testnet-session) below.

## Verified live testnet session

On 2026-11-26 the agent completed a bootstrap cycle and 12 further autonomous cycles on chain ID 133. Both swaps, their approvals, the wrap, the deployment, and both DecisionLog transactions have successful receipts. Each DecisionLogged event references its matching swap hash.

This session used the strategy before gas-floor and fee-aware planning enhancements. Its receipts and 17 ledger records are historical evidence for that version; enhanced behavior is covered by unit tests and read-only preflight/audit, with no new live swap.

| Step | Result | On-chain transaction |
| --- | --- | --- |
| Wrap 0.01 HSK to WHSK | Success, block 36242450 | [`0x53df2e8c69503170e6f96fa1c3b158fb4629a75d72167e08bd2c7667306263cc`](https://testnet-explorer.hskchain.net/tx/0x53df2e8c69503170e6f96fa1c3b158fb4629a75d72167e08bd2c7667306263cc) |
| Approve WHSK to SwapRouter02 | Success, block 36242454 | [`0xbd4506e9e8ec1ef56a64e0f30e3468b6d37cdc9e65d07ad3813e919e2512d9fa`](https://testnet-explorer.hskchain.net/tx/0xbd4506e9e8ec1ef56a64e0f30e3468b6d37cdc9e65d07ad3813e919e2512d9fa) |
| Bootstrap swap: 0.01 WHSK → 0.172180703260754993 TT1 | Success; empty inventory triggered bootstrap | [`0xb98e2e6b039342a364113aebaa1ebe656af8573344d1d70e76516964fb717d92`](https://testnet-explorer.hskchain.net/tx/0xb98e2e6b039342a364113aebaa1ebe656af8573344d1d70e76516964fb717d92) |
| Record bootstrap decision | Success, block 36242460 | [`0x9a17d7b4c9e8a2db457cc50e0a905f9ebe713404cb3ec26b3c454dda8cf8598f`](https://testnet-explorer.hskchain.net/tx/0x9a17d7b4c9e8a2db457cc50e0a905f9ebe713404cb3ec26b3c454dda8cf8598f) |
| Approve TT1 to SwapRouter02 | Success, block 36242620 | [`0x06f21d08be3be649507105b8e89b7f4039394864af5a6e9fb149e4d8c88ef574`](https://testnet-explorer.hskchain.net/tx/0x06f21d08be3be649507105b8e89b7f4039394864af5a6e9fb149e4d8c88ef574) |
| Rebalance swap: 0.086090351630377497 TT1 → 0.259328888119975221 TT2 | Success; TT1 was 100% of portfolio value (5,000 bps above the 50% target), then settled at 50.06% of portfolio value (5,006 bps weight) | [`0x67df0cc6e2013ef7981402c7b8d93e85b0aff7064abe439c0feddef5e17815c4`](https://testnet-explorer.hskchain.net/tx/0x67df0cc6e2013ef7981402c7b8d93e85b0aff7064abe439c0feddef5e17815c4) |
| Record rebalance decision | Success, block 36242627 | [`0xd08e89bc145dad6378f01f62b671a76cf0a5059ddb5c30076a38d6760b180131`](https://testnet-explorer.hskchain.net/tx/0xd08e89bc145dad6378f01f62b671a76cf0a5059ddb5c30076a38d6760b180131) |

The final balance read at block 36242807 returned **0.089204694061578573 HSK**, **0 WHSK**, **0.259328888119975221 TT2**, and **0.086090351630377496 TT1**. At the last agent observation, the portfolio was valued at 0.171952583404081495 TT1 with a 5,006 bps TT1 weight, inside the configured 500 bps rebalance band. The first two ledger rows preceded funding. Row 3 recorded a reserve-blocked bootstrap at block 36242151 with 0.099699775767259497 HSK already in the wallet. Funding landed at block 36242016. Row 4 records the wrap. Rows 5–17 contain the bootstrap buy, four sell plans (three interval-blocked, one executed), and eight in-band HOLDs. The on-chain audit reports two matching DecisionLogged events.

## Run locally

Requirements: Node.js 22 or newer and npm. Trading and observation also require Linux `flock` (util-linux). There is no API key; the public testnet RPC is used directly.

```sh
npm ci
npm test
npm run check
npm run compile
```

Set `HSK_AGENT_KEY_FILE` to a file outside the repository containing either a raw 32-byte private key in hex or JSON with a `privateKey` field. The process reads the value into memory and never prints it. To configure the agent, copy `.env.example` to `.env`, set the key-file path, then export the values in your shell. The file is git-ignored. See [INTEGRATION.md](INTEGRATION.md) for the complete flow.

```sh
npm run preflight
npm run run
```

`preflight` is read-only and also reports the live bootstrap price, gas cost in TT1, and a rebalance preview with all six constraints, without appending ledger records or saving state. `npm run audit` is also read-only and inspects existing on-chain decision events. A fresh checkout audits this entry using the public deployment block and wallet in `deployment/registry.json`. To trade without local deployment metadata, export the registry address from `.env.example`. `deploy` is reserved for a separate registry. The run ledger remains in `logs/decisions.jsonl`.

For the published registry, audit rejects local deployment metadata with a different start block. A separate registry requires its own deployment block and is scanned without the published wallet filter; the output includes the effective `fromBlock` and `agent` (`null` for an unfiltered scan).

Enhancement verification on 2026-11-26: `npm test` passed **26/26**, `npm run check` (`tsc --noEmit`) passed, and read-only `preflight`/`audit` passed at block **36250674**. Preflight balances matched the documented final balances exactly, all six preview constraints passed (HOLD), and audit returned the same two matching swap events. No trading loop or ledger-writing observation was run.

Run the static dashboard at <http://127.0.0.1:4173> with `npm run dashboard`. Its `/logs/decisions.jsonl` endpoint serves the actual committed-and-live `logs/decisions.jsonl` file; the dashboard links swaps, approvals, and decision-log transactions to the testnet explorer.

## Reproduction values

The exact defaults live in [.env.example](.env.example). Important values are chain ID `133`, factory `0x2dC2...`, router `0xa691...`, QuoterV2 `0x73820...`, TT2 `0x0284...`, TT1 `0xC383...`, pair fee `3000`, target weight `5000` bps, band `500` bps, max input `0.1`, max position `2` TT1, slippage `100` bps, minimum interval `300` seconds, daily loss limit `500` bps, gas-floor multiple `2`, estimated gas `0.00015` HSK, bootstrap input `0.01` HSK, and gas reserve `0.02` HSK. The reserve is sized against the measured session fees above (0.000300 HSK one-off deployment; 0.000036–0.000142 HSK per routine transaction).

## Stage commits

- Discovery: `36d8303`, `c064ded`, `9b8bd84`
- Agent, contract, tests, dashboard: `b68f979`
- Gas reserve and deployment facts: `ddc894d`
- Bounded on-chain audit query: `835c58a`
- Live testnet receipts, session summary, and final balances: final stage
