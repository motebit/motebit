// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SettlementAnchor
 * @notice Append-only Merkle root anchoring for inter-relay settlement batches.
 *
 * Each relay periodically batches federation settlements into a Merkle tree
 * and anchors the root here. The contract stores nothing — it emits an event
 * that peers can verify against the event log.
 *
 * See: relay-federation-v1.md §7.6.5
 *
 * Gas: ~45K per anchor (one event emission, no storage writes).
 */
contract SettlementAnchor {
    /**
     * @notice Emitted when a relay anchors a settlement batch.
     * @param merkleRoot SHA-256 Merkle root of the settlement batch.
     * @param relayId    Relay's motebit_id (SHA-256 hashed to bytes32 for indexing).
     * @param leafCount  Number of settlements in the batch.
     * @param batchTimestamp Epoch seconds when the batch was created.
     */
    event SettlementBatchAnchored(
        bytes32 indexed merkleRoot,
        bytes32 indexed relayId,
        uint64 leafCount,
        uint64 batchTimestamp
    );

    /**
     * @notice Anchor a settlement batch Merkle root.
     * @dev No access control — any relay can anchor. The relay's Ed25519 signature
     *      on the AnchorRecord (off-chain) is the trust mechanism. This contract
     *      provides non-repudiability: once emitted, the relay cannot deny the batch.
     * @param merkleRoot SHA-256 root hash of the settlement Merkle tree.
     * @param relayId    Relay identifier (SHA-256 of the relay's motebit_id string).
     * @param leafCount  Number of settlements in the batch.
     */
    function anchor(
        bytes32 merkleRoot,
        bytes32 relayId,
        uint64 leafCount
    ) external {
        emit SettlementBatchAnchored(
            merkleRoot,
            relayId,
            leafCount,
            uint64(block.timestamp)
        );
    }
}
