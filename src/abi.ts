export const FACTORY_ABI = [
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
];

export const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
];

export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
];

export const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];

export const WHSK_ABI = ["function deposit() payable"];

export const DECISION_LOG_ABI = [
  "function sequence() view returns (uint256)",
  "function record(bytes32 decisionId,uint256 observedAt,int256 deviationBps,uint8 action,uint160 priceX96,uint256 amountIn,uint256 amountOut,bytes32 swapTxHash,bytes32 reasonHash) returns (uint256 id)",
  "event DecisionLogged(uint256 indexed sequence,address indexed agent,bytes32 indexed decisionId,uint256 observedAt,int256 deviationBps,uint8 action,uint160 priceX96,uint256 amountIn,uint256 amountOut,bytes32 swapTxHash,bytes32 reasonHash)",
];
