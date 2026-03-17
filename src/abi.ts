// GenLayer Staking Contract Events (38 events from genlayer-js SDK STAKING_ABI)
// GenLayer Slashing Contract Events (SlashedFromIdleness)
// Source: genlayer-js npm package, verified against genlayer-cli v0.35.0

export const STAKING_EVENTS_ABI = [
  // ============================================================
  // Validator Lifecycle
  // ============================================================
  {
    type: "event",
    name: "ValidatorJoin",
    inputs: [
      { name: "operator", type: "address", indexed: false },
      { name: "validator", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValidatorDeposit",
    inputs: [
      { name: "validator", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValidatorExit",
    inputs: [
      { name: "validator", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValidatorClaim",
    inputs: [
      { name: "validator", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValidatorPrime",
    inputs: [
      { name: "validator", type: "address", indexed: false },
      { name: "epoch", type: "uint256", indexed: false },
      { name: "validatorRewards", type: "uint256", indexed: false },
      { name: "delegatorRewards", type: "uint256", indexed: false },
      { name: "feeRewards", type: "uint256", indexed: false },
      { name: "feePenalties", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValidatorsRegistered",
    inputs: [
      { name: "count", type: "uint256", indexed: false },
    ],
  },

  // ============================================================
  // Delegator Lifecycle
  // ============================================================
  {
    type: "event",
    name: "DelegatorJoin",
    inputs: [
      { name: "validator", type: "address", indexed: false },
      { name: "delegator", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DelegatorExit",
    inputs: [
      { name: "validator", type: "address", indexed: false },
      { name: "delegator", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DelegatorClaim",
    inputs: [
      { name: "delegator", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },

  // ============================================================
  // Slashing / Ban / Quarantine
  // ============================================================
  {
    type: "event",
    name: "ValidatorSlash",
    inputs: [
      { name: "validator", type: "address", indexed: false },
      { name: "validatorSlashing", type: "uint256", indexed: false },
      { name: "delegatorSlashing", type: "uint256", indexed: false },
      { name: "epoch", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValidatorBannedIdleness",
    inputs: [
      { name: "validator", type: "address", indexed: false },
      { name: "bannedAt", type: "uint256", indexed: false },
      { name: "bannedUntil", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValidatorBannedDeterministic",
    inputs: [
      { name: "validator", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValidatorBanRemoved",
    inputs: [
      { name: "validator", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AllValidatorBansRemoved",
    inputs: [],
  },
  {
    type: "event",
    name: "ValidatorQuarantined",
    inputs: [
      { name: "validator", type: "address", indexed: false },
      { name: "quarantinedAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValidatorQuarantineRemoved",
    inputs: [
      { name: "validator", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValidatorQuarantineRepealed",
    inputs: [
      { name: "validator", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "QuarantinesCleanedUp",
    inputs: [
      { name: "startIndex", type: "uint256", indexed: false },
      { name: "processedCount", type: "uint256", indexed: false },
      { name: "nextIndex", type: "uint256", indexed: false },
    ],
  },

  // ============================================================
  // Epoch
  // ============================================================
  {
    type: "event",
    name: "EpochAdvance",
    inputs: [
      { name: "epoch", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EpochFinalize",
    inputs: [
      { name: "epoch", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EpochZeroEnded",
    inputs: [
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EpochHasPendingTribunals",
    inputs: [
      { name: "epoch", type: "uint256", indexed: false },
    ],
  },

  // ============================================================
  // Economics / Fees
  // ============================================================
  {
    type: "event",
    name: "InflationInitiated",
    inputs: [
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "InflationReceived",
    inputs: [
      { name: "amount", type: "uint256", indexed: false },
      { name: "epoch", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FeesReceived",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BurnToL1",
    inputs: [
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BurnFailed",
    inputs: [
      { name: "amount", type: "uint256", indexed: false },
    ],
  },

  // ============================================================
  // Governance / Config
  // ============================================================
  {
    type: "event",
    name: "SetValidatorMinimumStake",
    inputs: [
      { name: "validatorMinStake", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetDelegatorMinimumStake",
    inputs: [
      { name: "delegatorMinStake", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetMaxValidators",
    inputs: [
      { name: "maxValidators", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetEpochMinDuration",
    inputs: [
      { name: "epochMinDuration", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetEpochMinDurationThreshold",
    inputs: [
      { name: "epochMinDurationThreshold", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetEpochZeroMinDuration",
    inputs: [
      { name: "epochZeroMinDuration", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetValidatorWeightParams",
    inputs: [
      { name: "alpha", type: "uint256", indexed: false },
      { name: "beta", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetUnbondingPeriods",
    inputs: [
      { name: "delegatorUnbondingPeriod", type: "uint256", indexed: false },
      { name: "validatorUnbondingPeriod", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetReductionFactor",
    inputs: [
      { name: "reductionFactor", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetGen",
    inputs: [
      { name: "gen", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetDeepthought",
    inputs: [
      { name: "deepthought", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetTransactionFeesManager",
    inputs: [
      { name: "transactionFeesManager", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetStakingInvariant",
    inputs: [
      { name: "stakingInvariant", type: "address", indexed: false },
    ],
  },
] as const;

// Slashing contract events (separate contract address, discovered via staking.getSlashingAddress())
export const SLASHING_EVENTS_ABI = [
  {
    type: "event",
    name: "SlashedFromIdleness",
    inputs: [
      { name: "validator", type: "address", indexed: true },
      { name: "txId", type: "bytes32", indexed: false },
      { name: "epoch", type: "uint256", indexed: false },
      { name: "percentage", type: "uint256", indexed: false },
      { name: "txStatus", type: "uint8", indexed: false },
    ],
  },
] as const;

// ConsensusMain contract events (30 events from genlayer-js SDK testnetBradbury.ts)
// Contract address: 0x0112Bf6e83497965A5fdD6Dad1E447a6E004271D
export const CONSENSUS_EVENTS_ABI = [
  // ============================================================
  // Transaction Lifecycle
  // ============================================================
  {
    type: "event",
    name: "NewTransaction",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "activator", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "CreatedTransaction",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "txSlot", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TransactionActivated",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "leader", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "TransactionReceiptProposed",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "validators", type: "address[]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TransactionAccepted",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "TransactionUndetermined",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "TransactionFinalized",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "TransactionCancelled",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "cancelledBy", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "TransactionFinalizationFailed",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "TransactionNeedsRecomputation",
    inputs: [
      { name: "txIds", type: "bytes32[]", indexed: false },
    ],
  },

  // ============================================================
  // Voting
  // ============================================================
  {
    type: "event",
    name: "VoteCommitted",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "validator", type: "address", indexed: true },
      { name: "isLastVote", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VoteRevealed",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "validator", type: "address", indexed: true },
      { name: "voteType", type: "uint8", indexed: false },
      { name: "isLastVote", type: "bool", indexed: false },
      { name: "result", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AllVotesCommitted",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "newStatus", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TransactionLeaderRevealed",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
    ],
  },

  // ============================================================
  // Appeals
  // ============================================================
  {
    type: "event",
    name: "AppealStarted",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "appellant", type: "address", indexed: true },
      { name: "bond", type: "uint256", indexed: false },
      { name: "validators", type: "address[]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TribunalAppealVoteCommitted",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "tribunalIndex", type: "uint256", indexed: false },
      { name: "validator", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "TribunalAppealVoteRevealed",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "tribunalIndex", type: "uint256", indexed: false },
      { name: "validator", type: "address", indexed: true },
      { name: "voteType", type: "uint8", indexed: false },
    ],
  },

  // ============================================================
  // Leader/Validator Rotation & Timeout
  // ============================================================
  {
    type: "event",
    name: "TransactionLeaderRotated",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "newLeader", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "TransactionLeaderTimeout",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "LeaderIdlenessProcessed",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "oldLeader", type: "address", indexed: true },
      { name: "newLeader", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "ValidatorReplaced",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "oldValidator", type: "address", indexed: true },
      { name: "newValidator", type: "address", indexed: true },
      { name: "validatorIndex", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ActivatorReplaced",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "oldActivator", type: "address", indexed: true },
      { name: "newActivator", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "ProcessIdlenessAccepted",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
    ],
  },

  // ============================================================
  // Infrastructure
  // ============================================================
  {
    type: "event",
    name: "BatchFinalizationCompleted",
    inputs: [
      { name: "attempted", type: "uint256", indexed: false },
      { name: "succeeded", type: "uint256", indexed: false },
      { name: "failed", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "InternalMessageProcessed",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "activator", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "ValueWithdrawalFailed",
    inputs: [
      { name: "txId", type: "bytes32", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AddressManagerSet",
    inputs: [
      { name: "addressManager", type: "address", indexed: true },
    ],
  },
] as const;

// VoteType enum values (from ITransactions.VoteType)
export const VOTE_TYPES: Record<number, string> = {
  0: "NOT_VOTED",
  1: "AGREE",
  2: "DISAGREE",
  3: "TIMEOUT",
  4: "DETERMINISTIC_VIOLATION",
};

// TransactionStatus enum values (from ITransactions.TransactionStatus)
export const TX_STATUSES: Record<number, string> = {
  0: "UNINITIALIZED",
  1: "PENDING",
  2: "PROPOSING",
  3: "COMMITTING",
  4: "REVEALING",
  5: "ACCEPTED",
  6: "UNDETERMINED",
  7: "FINALIZED",
  8: "CANCELED",
  9: "APPEAL_REVEALING",
  10: "APPEAL_COMMITTING",
  11: "VALIDATORS_TIMEOUT",
  12: "LEADER_TIMEOUT",
  13: "READY_TO_FINALIZE",
};

// Combined ABI for use with viem
export const ALL_EVENTS_ABI = [
  ...STAKING_EVENTS_ABI,
  ...SLASHING_EVENTS_ABI,
  ...CONSENSUS_EVENTS_ABI,
] as const;

// Event name to category mapping for easier querying
export const EVENT_CATEGORIES: Record<string, string> = {
  ValidatorJoin: "validator_lifecycle",
  ValidatorDeposit: "validator_lifecycle",
  ValidatorExit: "validator_lifecycle",
  ValidatorClaim: "validator_lifecycle",
  ValidatorPrime: "validator_lifecycle",
  ValidatorsRegistered: "validator_lifecycle",
  DelegatorJoin: "delegator_lifecycle",
  DelegatorExit: "delegator_lifecycle",
  DelegatorClaim: "delegator_lifecycle",
  ValidatorSlash: "slashing",
  ValidatorBannedIdleness: "slashing",
  ValidatorBannedDeterministic: "slashing",
  ValidatorBanRemoved: "slashing",
  AllValidatorBansRemoved: "slashing",
  ValidatorQuarantined: "quarantine",
  ValidatorQuarantineRemoved: "quarantine",
  ValidatorQuarantineRepealed: "quarantine",
  QuarantinesCleanedUp: "quarantine",
  EpochAdvance: "epoch",
  EpochFinalize: "epoch",
  EpochZeroEnded: "epoch",
  EpochHasPendingTribunals: "epoch",
  InflationInitiated: "economics",
  InflationReceived: "economics",
  FeesReceived: "economics",
  BurnToL1: "economics",
  BurnFailed: "economics",
  SetValidatorMinimumStake: "governance",
  SetDelegatorMinimumStake: "governance",
  SetMaxValidators: "governance",
  SetEpochMinDuration: "governance",
  SetEpochMinDurationThreshold: "governance",
  SetEpochZeroMinDuration: "governance",
  SetValidatorWeightParams: "governance",
  SetUnbondingPeriods: "governance",
  SetReductionFactor: "governance",
  SetGen: "governance",
  SetDeepthought: "governance",
  SetTransactionFeesManager: "governance",
  SetStakingInvariant: "governance",
  SlashedFromIdleness: "slashing",
  // Consensus contract events
  NewTransaction: "consensus_tx",
  CreatedTransaction: "consensus_tx",
  TransactionActivated: "consensus_tx",
  TransactionReceiptProposed: "consensus_tx",
  TransactionAccepted: "consensus_tx",
  TransactionUndetermined: "consensus_tx",
  TransactionFinalized: "consensus_tx",
  TransactionCancelled: "consensus_tx",
  TransactionFinalizationFailed: "consensus_tx",
  TransactionNeedsRecomputation: "consensus_tx",
  VoteCommitted: "consensus_vote",
  VoteRevealed: "consensus_vote",
  AllVotesCommitted: "consensus_vote",
  TransactionLeaderRevealed: "consensus_vote",
  AppealStarted: "consensus_appeal",
  TribunalAppealVoteCommitted: "consensus_appeal",
  TribunalAppealVoteRevealed: "consensus_appeal",
  TransactionLeaderRotated: "consensus_rotation",
  TransactionLeaderTimeout: "consensus_rotation",
  LeaderIdlenessProcessed: "consensus_rotation",
  ValidatorReplaced: "consensus_rotation",
  ActivatorReplaced: "consensus_rotation",
  ProcessIdlenessAccepted: "consensus_rotation",
  BatchFinalizationCompleted: "consensus_infra",
  InternalMessageProcessed: "consensus_infra",
  ValueWithdrawalFailed: "consensus_infra",
  AddressManagerSet: "consensus_infra",
};
