/**
 * The Case Supervisor for Relationship Operations (R1 SL-4, shadow).
 *
 * The public surface mirrors admission's and resolution's: one entry point per
 * governed operation, plus the model seam, plus the reads a verifier or a later
 * projection needs. There is deliberately no export that records a posture,
 * creates `agent_proposed` Work or writes a commitment fact on its own — every
 * guarantee in the Slice Acceptance Contract lives on the executor's path, and
 * the wake claim, the safe-yield gate and the shadow assertion are only
 * coherent when they run together.
 *
 * The judge is exported separately from the executor because it is the other
 * side of the Methodology §13 line: it proposes what work is useful now, and it
 * can never make anything happen.
 *
 * Server-only: the executor reaches service-role tables.
 */
export {
  runSupervisorWake,
  buildWakeKey,
  checkSafeYield,
  isNoActionPosture,
  listPostureHistory,
  type PostureHistoryEntry,
  type SupervisorRequest,
  type SupervisorResult,
  type SupervisorWake,
  type SupervisorInertReason,
  type SupervisorRefusalReason,
} from "./supervise";
export {
  createOpenRouterNextWorkJudge,
  buildNextWorkPrompt,
  normalizeNextWorkProposal,
  NextWorkProposalSchema,
  PROPOSABLE_POSTURES,
  type NextWorkJudge,
  type NextWorkProposal,
  type SupervisorJudgeInput,
} from "./next-work-judge";
export {
  resolveDeliveryEligibility,
  DELIVERY_RESTRICTION_FACT_KEY,
  type DeliveryEligibility,
  type DeliveryRestrictionFactValue,
  type OutboundBlockReason,
} from "./delivery";
export {
  recordCommitments,
  summarizeOpenCommitments,
  COMMITMENT_KEY_ATTR,
  type ProposedCommitment,
  type RecordedCommitment,
} from "./commitments";
export {
  reconstructSituation,
  checkPostureHistoryCoherence,
  distinctDaysCovered,
  type ReconstructedSituation,
  type ReconstructedCommitment,
} from "./replay";
export {
  summarizePostureDistribution,
  type PostureDistribution,
} from "./observability";
