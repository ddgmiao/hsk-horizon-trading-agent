// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract AgentDecisionLog {
    uint256 public sequence;

    event DecisionLogged(
        uint256 indexed sequence,
        address indexed agent,
        bytes32 indexed decisionId,
        uint256 observedAt,
        int256 deviationBps,
        uint8 action,
        uint160 priceX96,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 swapTxHash,
        bytes32 reasonHash
    );

    function record(
        bytes32 decisionId,
        uint256 observedAt,
        int256 deviationBps,
        uint8 action,
        uint160 priceX96,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 swapTxHash,
        bytes32 reasonHash
    ) external returns (uint256 id) {
        id = ++sequence;
        emit DecisionLogged(
            id,
            msg.sender,
            decisionId,
            observedAt,
            deviationBps,
            action,
            priceX96,
            amountIn,
            amountOut,
            swapTxHash,
            reasonHash
        );
    }
}
