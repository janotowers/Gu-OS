/**
 * Work Portfolio — R1 Relationship Operations SL-7 (S4; Technical Plan TD-9
 * v1, TD-15; Slice Plan SL-7).
 *
 * The authorized supervisory projection over an Organization's Cases: what
 * needs a human now and why, what Gu holds, what waits. It is NOT a second
 * source of truth (S4 invariant 1): every section below is computed from
 * Case / Fact / Work / Approval truth on each request, and the only thing this
 * page writes on its own behalf is the viewer's personal presentation.
 *
 * Everything that decides — membership, `relationship_ops`, the predicates,
 * the presentation guard, the action gates — lives in
 * `@/lib/work-portfolio` and is proven there; this file renders.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  createServerClient,
  listActiveOrganizationIdsForUser,
} from "@agents/db";
import {
  PORTFOLIO_SNOOZE_OPTIONS_DAYS,
  type AttentionProjection,
  type ContextualAttention,
  type DurableRef,
} from "@agents/types";
import { AppShell } from "@/components/app-shell";
import { createClient } from "@/lib/supabase/server";
import { hitlActionsForInteraction } from "@/lib/human-interaction/hitl-adapter";
import { workReviewActionPresentation } from "@/lib/operations/work-view-labels";
import { loadWorkPortfolio } from "@/lib/work-portfolio/load";
import type { PortfolioEntry } from "@/lib/work-portfolio/projection";
import { PORTFOLIO_SECTIONS } from "@/lib/work-portfolio/projection";
import {
  createOpenRouterRankingJudge,
  rankWorkPortfolio,
  type RankedPortfolioEntry,
  type RankedPortfolioView,
  type RankingSummary,
} from "@/lib/work-portfolio/ranking";
import {
  authorityCopy,
  CONTEXTUAL_COPY,
  POSTURE_COPY,
  PREDICATE_COPY,
  RANKING_STATUS_COPY,
  REFUSAL_COPY,
  renderClause,
  SECTION_COPY,
} from "@/lib/work-portfolio/copy";
import type { PortfolioRefusal } from "@/lib/work-portfolio/actions";
import {
  portfolioCompleteWorkAction,
  portfolioDecideApprovalAction,
  portfolioPresentationAction,
} from "./actions";

export const dynamic = "force-dynamic";

const TITLE = "Portafolio de trabajo";
const DESCRIPTION =
  "Qué necesita a una persona ahora y por qué, qué maneja Gu y qué espera — proyectado desde la verdad de los Casos, nunca como una segunda fuente de verdad.";

type View = "mine" | "org";

function instantFormatter(timeZone: string | null) {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("es-MX", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timeZone || "UTC",
    });
  } catch {
    format = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  }
  return (iso: string | null) => {
    if (!iso) return "—";
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? iso : format.format(new Date(ms));
  };
}

function shortRef(ref: DurableRef): string {
  return `${ref.kind} · ${ref.id.slice(0, 8)}`;
}

function Notice({ notice }: { notice: string | null }) {
  if (!notice) return null;
  if (notice === "done") {
    return (
      <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
        Listo. El cambio quedó en el mecanismo que lo posee.
      </p>
    );
  }
  if (notice === "inert") {
    return (
      <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
        Relationship Operations está apagado para esta Organización: no se escribió nada.
      </p>
    );
  }
  // The notice comes from the URL, so only an OWN key of the copy table may
  // select a message — never an inherited one such as `__proto__`.
  const reason = notice.startsWith("refused:") ? notice.slice("refused:".length) : "";
  const message = Object.prototype.hasOwnProperty.call(REFUSAL_COPY, reason)
    ? REFUSAL_COPY[reason as PortfolioRefusal]
    : "Motivo desconocido.";
  return (
    <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
      No se hizo el cambio. {message}
    </p>
  );
}

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "amber" | "sky" | "violet" | "emerald" | "red" }) {
  const tones = {
    neutral: "border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300",
    amber: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
    sky: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200",
    violet: "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    red: "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
  } as const;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Hidden({ organizationId, view, caseId }: { organizationId: string; view: View; caseId: string }) {
  return (
    <>
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="view" value={view} />
      <input type="hidden" name="case_id" value={caseId} />
    </>
  );
}

const buttonClass =
  "rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50";
const variantClass = {
  primary: "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  secondary: "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200",
  danger: "border-red-300 bg-red-50 text-red-800 hover:bg-red-100 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
} as const;

function InteractionActions({
  item,
  entry,
  organizationId,
  view,
}: {
  item: AttentionProjection;
  entry: PortfolioEntry;
  organizationId: string;
  view: View;
}) {
  const interaction = item.interaction;
  const actions = hitlActionsForInteraction(interaction);

  if (interaction.interaction === "approval_request") {
    if (!entry.canDecideApprovals) {
      return (
        <p className="text-xs text-neutral-500">
          La deciden owner u org_admin. La asignación del Caso no otorga autoridad de aprobación.
        </p>
      );
    }
    return (
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <form key={action.id} action={portfolioDecideApprovalAction} className="flex flex-wrap items-end gap-2">
            <Hidden organizationId={organizationId} view={view} caseId={entry.case.id} />
            <input type="hidden" name="request_id" value={interaction.interaction_id.split(":").slice(1).join(":")} />
            <input type="hidden" name="decision" value={action.id === "approve" ? "approved" : "rejected"} />
            {action.acceptsNotes ? (
              <input
                name="notes"
                required={action.requiresNotes}
                placeholder={action.notesPlaceholder}
                className="w-56 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              />
            ) : null}
            <button type="submit" className={`${buttonClass} ${variantClass[action.variant ?? "secondary"]}`}>
              {action.label}
            </button>
          </form>
        ))}
      </div>
    );
  }

  const workItemId =
    interaction.interaction === "information_request" || interaction.interaction === "human_work_request"
      ? interaction.work_item_id
      : null;
  const work = workItemId ? entry.openWork.find((w) => w.id === workItemId) : undefined;
  if (work?.status === "review" && workReviewActionPresentation(work.work_type).kind === "domain_decision") {
    const presentation = workReviewActionPresentation(work.work_type);
    return (
      <p className="text-xs text-neutral-500">
        {presentation.kind === "domain_decision" ? presentation.guidance : null}
      </p>
    );
  }
  if (!workItemId || actions.length === 0) {
    const why =
      item.predicate === "due_commitment"
        ? "Se cumple en el compromiso mismo, no desde aquí."
        : item.predicate === "stalled"
          ? "Ninguna acción de esta versión resuelve un estancamiento; requiere revisión."
          : "Sin acción en esta versión.";
    return <p className="text-xs text-neutral-500">{why}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {actions.map((action) => (
        <form key={action.id} action={portfolioCompleteWorkAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Hidden organizationId={organizationId} view={view} caseId={entry.case.id} />
          <input type="hidden" name="work_item_id" value={workItemId} />
          {action.acceptsNotes ? (
            <textarea
              name="notes"
              required={action.requiresNotes}
              placeholder={action.notesPlaceholder}
              rows={2}
              className="min-w-0 flex-1 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
            />
          ) : null}
          <button type="submit" className={`${buttonClass} ${variantClass[action.variant ?? "primary"]}`}>
            {action.label}
          </button>
        </form>
      ))}
    </div>
  );
}

function AttentionCard({
  item,
  entry,
  organizationId,
  view,
  formatInstant,
}: {
  item: AttentionProjection;
  entry: PortfolioEntry;
  organizationId: string;
  view: View;
  formatInstant: (iso: string | null) => string;
}) {
  const rows: Array<[string, typeof item.why]> = [
    ["Por qué", item.why],
    ["Qué necesita Gu", item.what_gu_needs],
    ["Por qué ahora", item.why_now],
  ];
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/40">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="amber">{PREDICATE_COPY[item.predicate]}</Badge>
        <span className="text-[11px] text-neutral-500">obligación gobernada · no se puede ocultar</span>
      </div>
      <dl className="mt-2 space-y-1.5 text-sm">
        {rows.map(([label, clause]) => (
          <div key={label}>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{label}</dt>
            <dd className="text-neutral-900 dark:text-neutral-100">
              {renderClause(clause, formatInstant)}
              <span className="ml-2 font-mono text-[10px] text-neutral-400">
                {clause.refs.map(shortRef).join(" · ")}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3">
        <InteractionActions item={item} entry={entry} organizationId={organizationId} view={view} />
      </div>
    </div>
  );
}

/**
 * A discretionary attention item (SL-12): the model's words, each shown with
 * the durable rows it cites — the merge kept it only because every one of them
 * is this Case's own. Rendered as text, never as markup.
 */
function ContextualCard({ item }: { item: ContextualAttention }) {
  const rows: Array<[string, ContextualAttention["why"]]> = [
    [CONTEXTUAL_COPY.why, item.why],
    [CONTEXTUAL_COPY.whatGuNeeds, item.what_gu_needs],
    [CONTEXTUAL_COPY.whyNow, item.why_now],
  ];
  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3 dark:border-sky-900 dark:bg-sky-950/40">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="sky">{CONTEXTUAL_COPY.badge}</Badge>
        <span className="text-[11px] text-neutral-500">{CONTEXTUAL_COPY.note}</span>
      </div>
      <dl className="mt-2 space-y-1.5 text-sm">
        {rows.map(([label, claim]) => (
          <div key={label}>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{label}</dt>
            <dd className="text-neutral-900 dark:text-neutral-100">
              {claim.text}
              <span className="ml-2 font-mono text-[10px] text-neutral-400">
                {claim.refs.map(shortRef).join(" · ")}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PresentationControls({
  entry,
  organizationId,
  view,
}: {
  entry: PortfolioEntry;
  organizationId: string;
  view: View;
}) {
  const p = entry.presentation;
  const simple = (change: string, label: string) => (
    <form action={portfolioPresentationAction}>
      <Hidden organizationId={organizationId} view={view} caseId={entry.case.id} />
      <input type="hidden" name="change" value={change} />
      <button type="submit" className={`${buttonClass} ${variantClass.secondary}`}>
        {label}
      </button>
    </form>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {simple("seen", p.seenAt ? "Visto ✓" : "Marcar visto")}
      <form action={portfolioPresentationAction} className="flex items-center gap-1">
        <Hidden organizationId={organizationId} view={view} caseId={entry.case.id} />
        <input type="hidden" name="change" value="snooze" />
        <select
          name="days"
          defaultValue="1"
          className="rounded-md border border-neutral-300 px-1.5 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
        >
          {PORTFOLIO_SNOOZE_OPTIONS_DAYS.map((days) => (
            <option key={days} value={days}>
              {days} {days === 1 ? "día" : "días"}
            </option>
          ))}
        </select>
        <button type="submit" className={`${buttonClass} ${variantClass.secondary}`}>
          Posponer
        </button>
      </form>
      {p.snoozedUntil ? simple("unsnooze", "Quitar pospuesto") : null}
      {p.userSuppression === "hidden" ? simple("unhide", "Mostrar") : simple("hide", "Ocultar")}
      {p.pinned ? simple("unpin", "Desfijar") : simple("pin", "Fijar")}
    </div>
  );
}

function CaseCard({
  entry,
  organizationId,
  view,
  actorUserId,
  formatInstant,
}: {
  entry: RankedPortfolioEntry;
  organizationId: string;
  view: View;
  actorUserId: string;
  formatInstant: (iso: string | null) => string;
}) {
  const authority = authorityCopy(entry.case.runtime_authority);
  const assigned =
    entry.case.assigned_to_user_id === actorUserId
      ? "Asignado a ti"
      : entry.case.assigned_to_user_id
        ? "Asignado a otro miembro"
        : "Sin asignar";
  const latest = entry.posture.basis;
  return (
    <article id={`case-${entry.case.id}`} className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {entry.objective || `Oportunidad · ${entry.case.id.slice(0, 8)}`}
          </h3>
          <p className="mt-0.5 font-mono text-[10px] text-neutral-400">
            {entry.case.case_type} · {entry.case.id}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {entry.section === "needs_attention" && entry.rank !== null ? (
            <Badge tone="amber">{CONTEXTUAL_COPY.rank(entry.rank)}</Badge>
          ) : null}
          {entry.presentation.pinned ? <Badge tone="violet">Fijado</Badge> : null}
          <Badge tone={entry.case.runtime_authority === "gu_os" ? "sky" : "neutral"}>
            <span title={authority.detail}>{authority.label}</span>
          </Badge>
          <Badge>{assigned}</Badge>
          <Badge>{entry.case.status}</Badge>
        </div>
      </header>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {entry.posture.reconsidered ? (
          entry.posture.postures.map((posture) => (
            <Badge key={posture} tone={posture === "needs_attention" ? "amber" : posture === "outcomes" ? "emerald" : "sky"}>
              {POSTURE_COPY[posture]}
              {entry.posture.mode === "shadow" ? " (sombra)" : ""}
            </Badge>
          ))
        ) : (
          <span className="text-xs text-neutral-500">Sin postura: Gu OS aún no ha reconsiderado este Caso.</span>
        )}
        {entry.closure ? (
          <Badge tone="emerald">
            Cierre: {entry.closure.outcome ?? "—"}
            {entry.closure.reason ? ` · ${entry.closure.reason}` : ""}
          </Badge>
        ) : null}
      </div>

      {entry.presentation.exemptBecauseMustSurface ? (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Lo {entry.presentation.userSuppression === "hidden" ? "ocultaste" : "pospusiste"}, pero sigue visible: contiene una obligación gobernada que tu vista personal no puede quitar.
        </p>
      ) : null}

      {entry.contextual ? (
        <div className="mt-3">
          <ContextualCard item={entry.contextual} />
        </div>
      ) : null}

      {entry.attention.length > 0 ? (
        <div className="mt-3 space-y-2">
          {entry.attention.map((item) => (
            <AttentionCard
              key={item.id}
              item={item}
              entry={entry}
              organizationId={organizationId}
              view={view}
              formatInstant={formatInstant}
            />
          ))}
        </div>
      ) : null}

      {latest ? (
        <p className="mt-3 text-xs text-neutral-600 dark:text-neutral-400">
          <span className="font-semibold">Última reconsideración</span> ({formatInstant(latest.claimed_at)}):{" "}
          {latest.rationale || "—"}
          {latest.next_action_at ? ` · próxima: ${formatInstant(latest.next_action_at)}` : ""}
        </p>
      ) : null}

      {entry.commitments.length > 0 || entry.openWork.length > 0 ? (
        <details className="mt-2 text-xs text-neutral-700 dark:text-neutral-300">
          <summary className="cursor-pointer select-none text-neutral-500">
            Compromisos ({entry.commitments.length}) · trabajo abierto ({entry.openWork.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {entry.commitments.map((c) => (
              <li key={c.subjectId}>
                <span className="font-medium">{c.expected ?? "Compromiso"}</span> — {c.actor ?? "?"} · {c.status ?? "?"} ·{" "}
                {c.dueState === "instant"
                  ? `fecha ${formatInstant(c.dueAt)}`
                  : c.dueState === "expression"
                    ? `«${c.dueExpression}» (sin resolver; nunca se convierte en fecha)`
                    : c.dueState === "contract_violation"
                      ? "fecha inválida (violación del contrato de commitment.due)"
                      : "sin fecha"}
              </li>
            ))}
            {entry.openWork.map((w) => (
              <li key={w.id} className="font-mono text-[11px]">
                {w.work_type} — {w.status} ({w.origin})
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="mt-3 border-t border-neutral-100 pt-3 dark:border-neutral-800">
        <PresentationControls entry={entry} organizationId={organizationId} view={view} />
        <p className="mt-1 text-[10px] text-neutral-400">
          Visto, pospuesto, oculto y fijado cambian solo tu vista; nunca resuelven una necesidad.
        </p>
      </div>
    </article>
  );
}

function PortfolioSections({
  portfolioView,
  ranking,
  organizationId,
  view,
  actorUserId,
  formatInstant,
}: {
  portfolioView: RankedPortfolioView;
  ranking: RankingSummary;
  organizationId: string;
  view: View;
  actorUserId: string;
  formatInstant: (iso: string | null) => string;
}) {
  const sections = PORTFOLIO_SECTIONS.map((section) => ({
    section,
    entries: portfolioView.entries.filter((e) => e.section === section),
  })).filter((group) => group.entries.length > 0);

  return (
    <div className="space-y-6">
      {sections.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No hay Casos en esta vista.
        </p>
      ) : null}
      {sections.map(({ section, entries }) => (
        <section key={section}>
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {SECTION_COPY[section].title} <span className="text-neutral-400">({entries.length})</span>
          </h2>
          <p className="mb-2 text-xs text-neutral-500">{SECTION_COPY[section].note}</p>
          {section === "needs_attention" ? (
            <p className="mb-2 text-xs text-neutral-500">{RANKING_STATUS_COPY[ranking.status]}</p>
          ) : null}
          <div className="space-y-3">
            {entries.map((entry) => (
              <CaseCard
                key={entry.case.id}
                entry={entry}
                organizationId={organizationId}
                view={view}
                actorUserId={actorUserId}
                formatInstant={formatInstant}
              />
            ))}
          </div>
        </section>
      ))}
      {portfolioView.suppressed.length > 0 ? (
        <details className="rounded-2xl border border-neutral-200 p-3 dark:border-neutral-800">
          <summary className="cursor-pointer select-none text-sm text-neutral-600 dark:text-neutral-400">
            Pospuestos u ocultos por ti ({portfolioView.suppressed.length}) — ninguno contiene una obligación gobernada
          </summary>
          <div className="mt-3 space-y-3">
            {portfolioView.suppressed.map((entry) => (
              <CaseCard
                key={entry.case.id}
                entry={entry}
                organizationId={organizationId}
                view={view}
                actorUserId={actorUserId}
                formatInstant={formatInstant}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export default async function WorkPortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; view?: string; notice?: string }>;
}) {
  const sp = await searchParams;
  const view: View = sp.view === "org" ? "org" : "mine";
  const notice = typeof sp.notice === "string" && sp.notice.trim() ? sp.notice.trim() : null;

  const userDb = await createClient();
  const {
    data: { user },
  } = await userDb.auth.getUser();
  if (!user) redirect("/login");

  const serviceDb = createServerClient();
  const organizationIds = await listActiveOrganizationIdsForUser(serviceDb, user.id);
  if (organizationIds.length === 0) {
    return (
      <AppShell title={TITLE} description={DESCRIPTION}>
        <p className="rounded-2xl border border-neutral-200 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
          Tu cuenta no tiene una membresía activa en ninguna Organización, así que no hay un portafolio que mostrar.
        </p>
      </AppShell>
    );
  }
  const organizationId =
    sp.org && organizationIds.includes(sp.org) ? sp.org : organizationIds[0];

  const result = await loadWorkPortfolio({
    serviceDb,
    userDb,
    actorUserId: user.id,
    organizationId,
    now: new Date(),
  });

  if (result.status !== "ok") {
    return (
      <AppShell title={TITLE} description={DESCRIPTION}>
        <p className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {result.status === "inert"
            ? "Relationship Operations está apagado para esta Organización: el portafolio no lee ni escribe nada mientras lo esté."
            : "Tu membresía en esta Organización ya no está activa."}
        </p>
      </AppShell>
    );
  }

  const { data: profile } = await userDb.from("profiles").select("timezone").eq("id", user.id).maybeSingle();
  const formatInstant = instantFormatter((profile as { timezone?: string } | null)?.timezone ?? null);
  // SL-12: the contextual ranking pass, over the Portfolio SL-7 just built and
  // nothing else. Off, failing or slow, it returns SL-7's order and says so.
  const portfolio = await rankWorkPortfolio({
    serviceDb,
    organizationId,
    actor: result.portfolio.actor,
    portfolio: result.portfolio,
    snapshots: result.snapshots,
    judge: createOpenRouterRankingJudge(),
    now: new Date(),
  });
  const current = view === "org" ? portfolio.organizationWork : portfolio.myWork;
  const needs = (v: RankedPortfolioView) => v.entries.filter((e) => e.section === "needs_attention").length;
  const tab = (target: View, label: string, v: RankedPortfolioView) => {
    const params = new URLSearchParams({ org: organizationId, view: target });
    const active = view === target;
    return (
      <Link
        href={`/portfolio?${params.toString()}`}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
          active
            ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
            : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        }`}
      >
        {label} <span className="opacity-70">({v.entries.length})</span>
        {needs(v) > 0 ? <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-[10px] text-white">{needs(v)}</span> : null}
      </Link>
    );
  };

  return (
    <AppShell title={TITLE} description={DESCRIPTION}>
      <div className="space-y-4">
        <Notice notice={notice} />
        <nav className="flex flex-wrap items-center gap-2" aria-label="Vistas del portafolio">
          {tab("mine", "Mi trabajo", portfolio.myWork)}
          {tab("org", "Trabajo de la Organización", portfolio.organizationWork)}
          <span className="ml-auto text-xs text-neutral-500">
            Rol: {result.membership.role}
            {result.truncated ? " · mostrando los Casos más recientes" : ""}
          </span>
        </nav>
        {view === "mine" ? (
          <p className="text-xs text-neutral-500">
            Mi trabajo: los Casos asignados a ti y las aprobaciones que tu rol puede decidir. Un Caso sin asignar aparece solo en Trabajo de la Organización.
          </p>
        ) : null}
        <PortfolioSections
          portfolioView={current}
          ranking={portfolio.ranking}
          organizationId={organizationId}
          view={view}
          actorUserId={user.id}
          formatInstant={formatInstant}
        />
      </div>
    </AppShell>
  );
}
