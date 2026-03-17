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

// Combined ABI for use with viem
export const ALL_EVENTS_ABI = [
  ...STAKING_EVENTS_ABI,
  ...SLASHING_EVENTS_ABI,
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
};
