/**
 * Render adapter from the TD-15 typed contract to the CURRENT HITL action
 * contract (R1 SL-7; Technical Plan TD-15 point 3: "render adapters, not new
 * renderers").
 *
 * Cross-domain: it maps a semantic `HumanInteractionPayload` onto the action
 * definitions web chips and Telegram keyboards already render from, and adds
 * no Relationship-specific meaning. What an action DOES is decided by the
 * surface's own handler; this only says which actions a surface may offer for
 * an interaction.
 */
import type { HumanInteractionPayload } from "@agents/types";
import {
  buildHitlActionsForKind,
  type HitlActionDef,
} from "@/lib/operational-cases/hitl-action-contract";

/** The contract kind an interaction renders as: its semantic name. */
export function hitlKindForInteraction(payload: HumanInteractionPayload): string {
  return payload.interaction;
}

function actionData(payload: HumanInteractionPayload): Record<string, unknown> {
  switch (payload.interaction) {
    case "information_request":
      return { work_item_id: payload.work_item_id };
    case "human_work_request":
      return payload.work_item_id ? { work_item_id: payload.work_item_id } : {};
    case "approval_request":
      return { approval_kind: payload.approval_kind };
    default:
      return {};
  }
}

export function hitlActionsForInteraction(payload: HumanInteractionPayload): HitlActionDef[] {
  return buildHitlActionsForKind(hitlKindForInteraction(payload), actionData(payload));
}
