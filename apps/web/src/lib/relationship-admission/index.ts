/**
 * Governed admission for Relationship Operations (R1 SL-2, shadow).
 *
 * The public surface is deliberately one entry point plus the seams a caller
 * must supply. There is no "create an Opportunity" export and no way to write
 * an admission fact without going through the executor, because every guarantee
 * in the Slice Acceptance Contract lives on that path.
 *
 * Server-only: the executor reaches the SL-1 gateway and service-role tables.
 */
export {
  runAdmission,
  applyPolicyToProposal,
  type AdmissionRequest,
  type AdmissionResult,
  type AdmissionInertReason,
  type AdmissionSourceEvent,
} from "./admit";
export {
  resolveEffectiveAdmissionPolicy,
  parseAdmissionPolicy,
  type EffectiveAdmissionPolicy,
} from "./policy";
export {
  ingestLegacyLead,
  pollLegacyLeads,
  latestInboundMessage,
  deriveDedupKey,
  type IngestLegacyLeadParams,
  type IngestLegacyLeadResult,
} from "./ingest";
export {
  createDefaultHardBoundProbe,
  type HardBoundSubject,
  type PlatformHardBoundProbe,
} from "./hard-bounds";
export {
  createOpenRouterAdmissionInterpreter,
  buildInterpreterPrompt,
  normalizeProposal,
  ADMISSION_OBJECTIVE_CATEGORIES,
  AdmissionProposalSchema,
  type AdmissionInterpreter,
  type AdmissionInterpreterInput,
  type AdmissionObjectiveCategory,
} from "./interpreter";
