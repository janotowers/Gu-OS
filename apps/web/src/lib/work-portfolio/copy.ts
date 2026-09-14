/**
 * Words for the Work Portfolio's semantic codes (R1 SL-7).
 *
 * The projection carries reason codes, durable refs and values copied from
 * rows — never prose (TD-15: semantics, never rendering). This is the one
 * place those codes become Spanish, so a renderer cannot quietly change what a
 * clause asserts: every sentence below is a template over the clause's own
 * values, and a code without a template is a test failure, not a blank.
 *
 * Presentation vocabulary obeys S4's meanings: "Gu lo maneja" never implies a
 * running process, a shadow posture never reads as Gu OS being in charge, and
 * an unresolved timing is shown as stated — never as a date.
 */
import type {
  AttentionClause,
  MustSurfacePredicate,
  PortfolioPosture,
  RuntimeAuthority,
} from "@agents/types";
import type { PortfolioRefusal } from "./actions";
import type { PortfolioSection } from "./projection";

type Values = Readonly<Record<string, string | null>>;
type Template = (values: Values, formatInstant: (iso: string | null) => string) => string;

const v = (values: Values, key: string, fallback = "—") => values[key] ?? fallback;

export const CLAUSE_COPY: Record<string, Template> = {
  // WHY
  approval_pending: (x) => `Hay una aprobación pendiente (${v(x, "approval_kind")}).`,
  supervisor_awaits_human_input: (x) =>
    `La última reconsideración de Gu OS dejó el Caso esperando información humana.${
      x.rationale ? ` Motivo registrado: «${x.rationale}»` : ""
    }`,
  work_awaits_human_review: (x) => `Un trabajo (${v(x, "work_type")}) espera revisión humana.`,
  advisor_commitment_due: () => "Un compromiso del asesor, abierto, llegó a su fecha.",
  authority_unresolved: (x) =>
    `La autoridad de esta interacción está ${x.authority_state === "conflicting" ? "en conflicto" : "sin determinar"}.`,
  effect_outcome_unknown: (x) =>
    `Un efecto externo (${v(x, "capability")}) tiene resultado DESCONOCIDO — no confirmado ni fallido.`,
  gu_os_owns_responsibility: () => "Gu OS tiene la autoridad de runtime de esta Oportunidad.",

  // WHAT GU NEEDS
  decide_protected_decision: (x) => `Decidir: ${v(x, "decision_subject")}`,
  answer_targeted_question: (x) => `Responder: ${v(x, "question")}`,
  complete_human_review: (x) => `Completar: ${v(x, "expected")}`,
  fulfil_commitment: (x) => `Cumplir lo comprometido: ${v(x, "expected_outcome")}`,
  review_interaction_authority: () => "Revisar quién tiene la autoridad de la conversación.",
  reconcile_effect_outcome: () => "Establecer si el efecto ocurrió. Nunca reintentarlo a ciegas.",
  establish_reentry_path: () =>
    "Dar a esta responsabilidad un camino de reentrada: trabajo, una espera válida o una reconsideración.",

  // WHY NOW
  protected_decision_blocks_progress: (x, at) =>
    `Solicitada ${at(x.requested_at)}.${x.consequence ? ` ${x.consequence}` : ""}`,
  ask_unanswered: (x, at) => `Sin respuesta desde ${at(x.since)}; el trabajo sigue en «${v(x, "work_status")}».`,
  work_cannot_finish_without_human: (x, at) =>
    `No puede terminar sin una persona (en «${v(x, "work_status")}» desde ${at(x.since)}).`,
  due_instant_reached: (x, at) => `Su fecha era ${at(x.due_at)}.`,
  effects_suppressed_until_resolved: (x, at) =>
    `Detectado ${at(x.detected_at)}; ningún efecto autónomo sale hasta resolverlo.`,
  no_blind_retry: (x, at) => `Desde ${at(x.since)}; reenviar sin reconciliar podría duplicar el efecto.`,
  no_reentry_path: () =>
    "No hay reconsideración programada, trabajo pendiente ni respuesta humana esperada: nada lo va a despertar.",
};

export function renderClause(clause: AttentionClause, formatInstant: (iso: string | null) => string): string {
  const template = CLAUSE_COPY[clause.code];
  if (!template) throw new Error(`work-portfolio copy: no template for clause ${clause.code}`);
  return template(clause.values, formatInstant);
}

export const PREDICATE_COPY: Record<MustSurfacePredicate, string> = {
  pending_approval: "Aprobación pendiente",
  blocked_on_human: "Bloqueado en una persona",
  due_commitment: "Compromiso vencido",
  authority_conflict: "Conflicto de autoridad",
  unknown_outcome_effect: "Efecto con resultado desconocido",
  stalled: "Responsabilidad estancada",
};

export const SECTION_COPY: Record<PortfolioSection, { title: string; note: string }> = {
  needs_attention: {
    title: "Necesita atención",
    note: "Obligaciones gobernadas: siguen visibles aunque las pospongas u ocultes.",
  },
  gu_handling: {
    title: "Gu lo maneja",
    note: "Gu retiene la responsabilidad y no necesita a nadie ahora. No implica un proceso en ejecución.",
  },
  waiting: {
    title: "En espera",
    note: "Avanza cuando llegue una respuesta, una hora o una señal; Gu tiene un camino de reentrada.",
  },
  not_reconsidered: {
    title: "Sin postura de Gu OS",
    note: "Gu OS aún no los ha reconsiderado: no se les inventa una postura.",
  },
  outcomes: {
    title: "Resultados",
    note: "Casos con un cierre de negocio registrado (S1).",
  },
};

export const POSTURE_COPY: Record<PortfolioPosture, string> = {
  needs_attention: "Necesita atención",
  gu_handling: "Gu lo maneja",
  waiting: "En espera",
  watching: "Vigilando",
  outcomes: "Resultado registrado",
};

export function authorityCopy(authority: RuntimeAuthority | null): { label: string; detail: string } {
  if (authority === "gu_os") {
    return { label: "Gu OS decide", detail: "Gu OS tiene la autoridad de runtime de esta Oportunidad." };
  }
  if (authority === "legacy") {
    return {
      label: "Legacy decide · Gu OS en sombra",
      detail: "Traditional Gu sigue siendo autoritativo; Gu OS observa y registra su juicio sin actuar.",
    };
  }
  return { label: "Sin autoridad de runtime", detail: "Este Caso no tiene autoridad de runtime asignada." };
}

export const REFUSAL_COPY: Record<PortfolioRefusal, string> = {
  no_active_membership: "No tienes una membresía activa en esta Organización.",
  role_not_permitted: "Tu rol no puede tomar esta decisión: la deciden owner u org_admin. La asignación no otorga autoridad de aprobación.",
  unknown_action: "Acción desconocida.",
  case_not_in_organization: "Ese Caso no pertenece a esta Organización.",
  work_not_awaiting_human: "Ese trabajo ya no espera a una persona (se resolvió o cambió).",
  work_resolved_by_domain_decision:
    "Ese trabajo se cierra con su propia decisión de negocio en el caso, no marcándolo como hecho aquí.",
  work_not_claimable: "Ese trabajo no se puede tomar ahora (tiene dependencias, una fecha futura o un ejecutor lo tiene).",
  answer_required: "Escribe tu respuesta: es la información que Gu pidió.",
  no_pending_request: "No hay una solicitud de aprobación pendiente para decidir.",
  already_decided: "Esa aprobación ya se decidió en otra superficie; no se vuelve a pedir.",
  invalid_decision: "Decisión no válida.",
  invalid_change: "Cambio de presentación no válido (posponer: de 1 a 14 días).",
  claim_lost: "Otra persona o proceso cambió ese trabajo al mismo tiempo. Vuelve a intentarlo.",
};
