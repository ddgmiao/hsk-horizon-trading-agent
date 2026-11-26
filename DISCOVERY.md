# Phase 1 Discovery

Discovery performed against HashKey Chain Testnet RPC and its Blockscout API on 2026-11-26. All chain reads below use `https://testnet.hsk.xyz`; explorer evidence uses `https://testnet-explorer.hskchain.net/api/v2/`.

## Network and funding

- `eth_chainId` returned `0x85` (133).
- The agent address from the brief, `0x3ebc1896581bc0566A21903cC64Ed7e66F62284e`, returned `0x0` from `eth_getBalance` at `latest` and `0.0` in repeated agent preflights.
- `https://faucet.hskchain.net/faucet` serves a client-rendered page. Its shipped UI checks for a reCAPTCHA token before POSTing `{token,address}` to `https://faucet-api.hashkeychain.net/api/faucet/drip`. A direct curl POST with no HMAC headers timed out after 25 seconds; a request using the UI's public signing procedure but an empty reCAPTCHA token returned HTTP 403. No faucet transaction or HSK funding was observed. The faucet requires a human reCAPTCHA; it was not bypassed.

## Factory and router candidates

Explorer API search (`/search?q=UniswapV3Factory`) returned these seven verified contracts:

| Factory | Explorer verification |
| --- | --- |
| `0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0` | `UniswapV3Factory`, verified |
| `0x21F8252a908Dc94919Ce7DBce9e5222cE6808212` | `UniswapV3Factory`, verified |
| `0x502E2D3F7e79194b858DB1b2a2295d5C06B315FE` | `UniswapV3Factory`, verified |
| `0x8e97C632Fc5919fcCe6843fAA242De279a5905ec` | `UniswapV3Factory`, verified |
| `0x4Bba6F8eC4c5FC45338F25c75E3f018Aa3DCA48D` | `UniswapV3Factory`, verified |
| `0x29b01291dDC6A28007bd4aD5a533c5Ad06b00Df0` | `UniswapV3Factory`, verified |
| `0x28f4be0bE8C650E009A767ceA5a074988fF5ac06` | `UniswapV3Factory`, verified |

Explorer API search (`/search?q=SwapRouter02`) returned two verified `SwapRouter02` contracts: `0xa6914E66690c6794244B5f66a09eAEbf66254237` and `0x46cBccE3c74E95d1761435d52B0b9Abc9e2FEAC0`. Their verified source constructor order is `_factoryV2`, `factoryV3`, `_positionManager`, `_WETH9`. The first router's arguments set `factoryV2` to zero, `factoryV3` to `0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0`, `_positionManager` to `0x73dec6bfa6751509b08480bd97f54b874e3b20e8`, and `_WETH9` to `0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6` (verified by the explorer as Wrapped HSK, `WHSK`). The second router uses the same V3 factory but a different position manager and WETH9. The first router's explorer-indexed transaction page contains 50 recent transactions (with a next page); its latest displayed transaction, `0x1376be84db8cc99b0b5b35b628fba5a07c113e9bd956a55fa27cf880d8ff02ac`, is a successful `exactInputSingle` call to that router. The second router is also active in explorer transaction data.

Explorer search returns three verified `QuoterV2` deployments. `0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC` has verified constructor arguments `(factory=0x2dC2..., WETH9=0xCA8a...)` and the same creator as router `0xa691...`; a third quoter uses the second router's alternate WETH9. This provides an additional coherent router/factory/quoter deployment cluster for the `0xa691...` candidate.

This makes factory `0x2dC2...` and router `0xa691...` the strongest deployment candidates. The HSKSwap app origin, `https://app.hskswap.com`, returned an `Access Restricted` page stating that the service is unavailable in this jurisdiction. Its frontend configuration could not be inspected. The on-chain evidence ties both router candidates to the same factory but cannot distinguish which router the blocked frontend selects. Therefore the official app-to-deployment association is **not conclusively established** from the accessible evidence.

## Test-token leads and live pools

The two token addresses supplied as leads, `0xE4577dCF1C44F04cf489AA995E01e988f461cc4A` and `0xcF9bEC9f2769Ecc09107C58fA5eB0199D989A606`, resolve on testnet to separate unverified `TestToken1` (`TT1`) contracts with 18 decimals and 100,000,000 tokens each. Explorer holder results show the entire supply of each at the same creator address, `0xfCb42db392E6641fFA057f143aCe1953759f708f`; each token has one holder. No pool exists for this pair at fees 100, 500, 3000, or 10000 in any of the seven factory candidates, as checked by direct `getPool(address,address,uint24)` calls. These leads do not provide a usable trading pool.

Explorer search also returned verified test tokens `0xC383e13C47112b76be60f41ef5E5d8f9A8E75aE5` (`TestToken1`, `TT1`) and `0x0284eA6081C90fd5a48BCCc324C7bE1e46ea8cDb` (`TestToken2`, `TT2`), both 18 decimals and each with 100,000,000 initial supply. Their verified source is `SimpleERC20` and has no mint function; the shared creator address is `0xfCb42db392E6641fFA057f143aCe1953759f708f`. Explorer holder data shows the creator retains most of both supplies, with multiple other holders and pools already holding balances. The creator is the only evidenced distribution source; no public token faucet or unrestricted mint path was found. Direct `balanceOf(agent)` reads for TT1 and TT2 both returned zero.

Direct factory `getPool` reads for the verified TT1/TT2 pair found three pools only on factory `0x2dC2...`:

| Fee | Pool | Result |
| ---: | --- | --- |
| 500 | `0x3A856BaDAB1793c4DB46d6f220f2FF2a853BBDd1` | Exists |
| 3000 | `0xf826C65abDFF3B817e846DB4dfB68107CEFeB6b5` | Exists |
| 10000 | `0xF23b1D97d79Ab36F220ADCCFF3C1ad78174a2B9F` | Exists but has zero active `liquidity()` and only dust token balances |

The same pair returned zero from the other six factories at all four standard fee values checked (100, 500, 3000, 10000). The 500-fee pool has active liquidity `0x704533740fb8b5028f`; the 3000-fee pool has active liquidity `0x17071be9e0ecc4d750`. Explorer holder data reports the 3000 pool holds `244.340075732299112589 TT1` and `738.621090969642310216 TT2`; the 500 pool holds about `31.977155 TT1` and `172.475769 TT2`. The 10000 pool has zero active liquidity and only 3 wei of TT1 and 4 wei of TT2, so it is not a usable pool.

For the 3000-fee pool, explorer transaction `0x45ec2044d7e0afa4fafdddf9134952ca1ca98d6f1e626d9dcdf97d718cabc5d5` emitted `PoolCreated` from factory `0x2dC2...` with token0 `TT2`, token1 `TT1`, fee 3000, and pool `0xf826...`. The pool has nonzero active liquidity and a nonzero `slot0()` price. At the read used to build the agent, `sqrtPriceX96 = 45572482661888092273398720957`, approximately 0.33086148 TT1 per TT2 (both 18 decimals); a later preflight at block 36241084 observed liquidity `424787373830210639696`. Explorer holder data reports the 3000 pool holds `244.340075732299112589 TT1` and `738.621090969642310216 TT2`; the 500 pool holds about `31.977155 TT1` and `172.475769 TT2`. The 10000 pool has zero active liquidity and only 3 wei of TT1 and 4 wei of TT2, so it is not a usable pool. The agent successfully read this pool through `slot0()` and received a nonzero quote from the verified matching QuoterV2 for 0.01 TT2 in.

Explorer identifies `0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6` as verified `WHSK` (`Wrapped HSK`). Its verified source has a payable `deposit()` that wraps native HSK. Factory `0x2dC2...` maps WHSK/TT1 at fee 3000 to pool `0x9fCdf0d609B36e2C8F8a194BeD2583c772d6EF76`; this pool has nonzero `liquidity()` (`0x1a2808283344a0923`) and nonzero TT1 balance. The matching QuoterV2 returned `0.172180703260754993 TT1` for `0.01 WHSK` in a read-only quote. This gives a possible on-chain bootstrap route from testnet HSK to TT1 once the agent receives HSK. A later agent preflight returned zero HSK, zero WHSK, and zero TT1/TT2; a bootstrap execution attempt logged `bootstrap_blocked` with reason `Native HSK is below the configured gas reserve.` No transaction was sent.

The verified TT1/TT2 contracts are the best available official-test-token candidates because they are verified, have a common initial distributor, and have active pools on the strongest factory candidate. However, no accessible evidence links these exact testnet token addresses to the blocked HSKSwap frontend's `official` token list. That official-token association remains **probable, not proven**. The supplied unverified token leads are not pooled.

## Discovery verdict

- **Network:** verified, testnet chain ID 133.
- **Strongest factory candidate:** `0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0`; it is the factory argument in both verified router deployments and is the only discovered candidate with the active verified-TT1/TT2 pools.
- **Strongest router/quoter candidate:** router `0xa6914E66690c6794244B5f66a09eAEbf66254237` and QuoterV2 `0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC`; both verified, configured for factory `0x2dC2...` and WHSK `0xCA8a...`, with the same deployer. The second verified router references the same factory but uses alternate dependencies, so the frontend's exact selection is unresolved.
- **Usable pool and price path:** TT2/TT1 fee 3000 pool `0xf826C65abDFF3B817e846DB4dfB68107CEFeB6b5`; read `slot0()` and `liquidity()` on-chain.
- **Official token status:** unresolved; verified TT1/TT2 are strongest candidates but cannot be tied conclusively to the inaccessible official frontend.
- **Agent funding:** blocked on human reCAPTCHA and a successful 1 HSK faucet claim; the observed agent HSK, WHSK, TT1, and TT2 balances are all zero.
- **Next action requiring gas/tokens:** complete the faucet claim, then deploy the decision log and let the agent wrap/swap its configured 0.01 HSK seed to TT1. No direct TT2/TT1 token distribution is required for this bootstrap. Do not trade the unrelated `Test WHSK (AgentVault demo)` pair discovered on the same factory.
