/**
 * Duplicate & supersession resolution for Relationship Operations (R1 SL-3,
 * shadow).
 *
 * The public surface mirrors admission's: one entry point that applies a
 * governed determination, the recovery read that makes an incomplete
 * resolution discoverable, and the model seam. There is deliberately no export
 * that writes a lineage edge or a closure on its own — every guarantee in the
 * Slice Acceptance Contract lives on the executor's path, and the two governed
 * halves are only coherent when applied together.
 *
 * The judge is exported separately from the executor because it is the other
 * side of the Methodology §13 line: it proposes whether two Opportunities
 * represent one objective, and it can never resolve anything.
 *
 * Server-only: the executor reaches service-role tables.
 */
export {
  resolveCanonicalization,
  findIncompleteResolutions,
  proposeContinuity,
  type ResolutionKind,
  type ResolutionRequest,
  type ResolutionResult,
  type ResolutionInertReason,
  type ResolutionGap,
} from "./resolve";
export {
  createOpenRouterContinuityJudge,
  buildContinuityPrompt,
  normalizeContinuityProposal,
  ContinuityProposalSchema,
  type ContinuityJudge,
  type ContinuityJudgeInput,
  type ContinuityProposal,
  type OpportunitySummary,
} from "./continuity-judge";
