/**
 * Advisory equivalence comparison (SA-6.9 / SA-6.10).
 *
 * Compares two already-computed `humanActive` answers. It does not
 * resolve authority, persist incidents, or write any business row.
 * A divergence is a measurement, not a defect and not a Case fact.
 */
import type { OracleObservedInputs, OracleVerdict } from "./oracle";

export interface EquivalenceRecord {
  id: string;
  agreed: boolean;
  resolverHumanActive: boolean | null;
  oracleHumanActive: boolean | null;
  oracle: OracleVerdict;
  inputs: OracleObservedInputs;
  provenance: Record<string, unknown>;
}

export function recordAuthorityEquivalence(params: {
  id: string;
  resolverHumanActive: boolean | null;
  oracle: OracleVerdict;
  inputs: OracleObservedInputs;
  provenance?: Record<string, unknown>;
}): EquivalenceRecord {
  return {
    id: params.id,
    agreed: params.resolverHumanActive === params.oracle.humanActive,
    resolverHumanActive: params.resolverHumanActive,
    oracleHumanActive: params.oracle.humanActive,
    oracle: params.oracle,
    inputs: params.inputs,
    provenance: params.provenance ?? {},
  };
}
