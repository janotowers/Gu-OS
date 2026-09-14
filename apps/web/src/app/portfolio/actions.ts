"use server";

/**
 * Server Actions of the Work Portfolio (R1 SL-7).
 *
 * Thin: each one establishes WHO is acting from the session — never from the
 * form — and hands off to `@/lib/work-portfolio/actions`, where authorization
 * (`authorizeOrgAction`, active membership), the `relationship_ops` gate and
 * the canonical write paths live and are tested. Server Actions are reachable
 * by direct POST, so nothing here trusts a hidden field for authority: the
 * Organization and Case ids from the form are only claims the library checks.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerClient } from "@agents/db";
import { PORTFOLIO_SNOOZE_OPTIONS_DAYS } from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import {
  completePortfolioWork,
  decidePortfolioApproval,
  NO_APPROVAL_REQUEST_PRODUCER,
  writePortfolioPresentation,
  type PortfolioActionResult,
} from "@/lib/work-portfolio/actions";
import type { PresentationChange } from "@/lib/work-portfolio/presentation";

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function currentActor() {
  const userDb = await createClient();
  const {
    data: { user },
  } = await userDb.auth.getUser();
  if (!user) redirect("/login");
  return { userDb, userId: user.id };
}

function backToPortfolio(formData: FormData, result: PortfolioActionResult): never {
  const org = text(formData, "organization_id");
  const view = text(formData, "view") === "org" ? "org" : "mine";
  const caseId = text(formData, "case_id");
  const notice =
    result.status === "done" ? "done" : result.status === "inert" ? "inert" : `refused:${result.reason}`;
  revalidatePath("/portfolio");
  const params = new URLSearchParams({ org, view, notice });
  redirect(`/portfolio?${params.toString()}${caseId ? `#case-${caseId}` : ""}`);
}

function presentationChange(formData: FormData): PresentationChange | null {
  const kind = text(formData, "change");
  switch (kind) {
    case "seen":
    case "unsnooze":
    case "hide":
    case "unhide":
    case "pin":
    case "unpin":
      return { kind };
    case "snooze": {
      const days = Number(text(formData, "days"));
      return (PORTFOLIO_SNOOZE_OPTIONS_DAYS as readonly number[]).includes(days)
        ? { kind: "snooze", days }
        : null;
    }
    default:
      return null;
  }
}

export async function portfolioPresentationAction(formData: FormData): Promise<void> {
  const { userDb, userId } = await currentActor();
  const change = presentationChange(formData);
  const result: PortfolioActionResult = change
    ? await writePortfolioPresentation({
        serviceDb: createServerClient(),
        userDb,
        actorUserId: userId,
        organizationId: text(formData, "organization_id"),
        caseId: text(formData, "case_id"),
        change,
        now: new Date(),
      })
    : { status: "refused", reason: "invalid_change" };
  backToPortfolio(formData, result);
}

export async function portfolioCompleteWorkAction(formData: FormData): Promise<void> {
  const { userId } = await currentActor();
  const result = await completePortfolioWork({
    serviceDb: createServerClient(),
    actorUserId: userId,
    organizationId: text(formData, "organization_id"),
    caseId: text(formData, "case_id"),
    workItemId: text(formData, "work_item_id"),
    answer: text(formData, "notes"),
    now: new Date(),
  });
  backToPortfolio(formData, result);
}

export async function portfolioDecideApprovalAction(formData: FormData): Promise<void> {
  const { userId } = await currentActor();
  const result = await decidePortfolioApproval({
    serviceDb: createServerClient(),
    actorUserId: userId,
    organizationId: text(formData, "organization_id"),
    caseId: text(formData, "case_id"),
    requestId: text(formData, "request_id"),
    decision: text(formData, "decision"),
    rationale: text(formData, "notes") || null,
    // No Organization-Case approval producer exists before SL-9 (D4): the
    // live source finds nothing, so this action decides nothing yet.
    requests: NO_APPROVAL_REQUEST_PRODUCER,
    now: new Date(),
  });
  backToPortfolio(formData, result);
}
