import { plainLanguage } from "../lib/plain";
import { useMemo, useState, type KeyboardEvent } from "react";
import { ServingLine } from "./Banners";
import { RefList, RefMarks } from "./RefMarks";
import { answerEventId } from "../lib/sources";
import { numberAnswerReferences } from "../lib/references";
import { causalChain, skepticVerdicts } from "../fixtures/console";
import { useConsole } from "../context/ConsoleContext";
import { laneLabel } from "../lib/lanes";
import { routeHref } from "../lib/route";
import type { Grounding } from "../types/contract";
import type { SkepticOutcome } from "../types/skeptic";

/** Causal chain, Skeptic, and Judge. The human decision lives on Approvals, not here. */
export function ReviewColumn() {
  const desk = useConsole();
  const [tab, setTab] = useState<"chain" | "skeptic" | "judge">("chain");
  const judge = desk.answer.judge;
  const recordedRows = desk.discharge.origin !== "live";
  const refs = useMemo(
    () => numberAnswerReferences(desk.answer, { scope: "review", eventId: answerEventId(desk.answer) }),
    [desk.answer],
  );
  const marks = (claimId: string | undefined) => <RefMarks nums={refs.claims.find((c) => c.id === claimId)?.refs ?? []} refs={refs.refs} />;
  const tabs = [
    ["chain", "Causal chain"],
    ["skeptic", "Skeptic"],
    ["judge", "Judge"],
  ] as const;

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex(([id]) => id === tab);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    const id = tabs[next][0];
    setTab(id);
    document.getElementById(`tab-${id}`)?.focus();
  }

  return (
    <section className="card review" aria-label="Review">
      <div className="card-head">
        <div>
          <p className="section-label">Reviewed answer</p>
          <h2>{desk.answer.question}</h2>
        </div>
      </div>
      <ServingLine inline />
      
      <p className="note">
        Skeptic notes and Judge scores are fixtures for this screen. They are not a Nightshift call, and they do not
        choose a model lane. The human still decides. Nothing here is sent.
      </p>
      <p className="status-line">
        Decision <strong>{desk.approval.status}</strong> ·{" "}
        <a href={routeHref("insurer", "approvals")}>
          {desk.approval.status === "pending" ? "Decide on Approvals" : "Open Approvals"}
        </a>
      </p>
      <div className="review-tabs">
        <div className="tablist" role="tablist" aria-label="Review sections" onKeyDown={onTabKey}>
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              className={tab === id ? "tab active" : "tab"}
              aria-selected={tab === id}
              aria-controls={`panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="tab tab-link" onClick={() => desk.openEvidence("discharge")}>
          Evidence
        </button>
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
        {tab === "chain" && (
          <ol className="chain">

            {desk.discharge.origin === "seed" && (
              <li className="note">The chain quotes the seed extract on this desk.</li>
            )}
            {causalChain.map((link) => {
              const claim = desk.answer.claims.find((item) => item.claim_id === link.claim_id);
              const verdict = skepticVerdicts.find((item) => item.claim_id === link.claim_id);
              const score = judge?.claims.find((item) => item.claim_id === link.claim_id);
              return (
                <li key={link.id} className="step">
                  <p className="step-label">{link.label}</p>
                  <h3>{link.title}</h3>
                  <p title={claim?.text}>
                    {plainLanguage(claim?.text ?? "")} {marks(link.claim_id)}
                  </p>
                  <p className="note">{link.note}</p>
                  <div className="badge-row">
                    {verdict && <OutcomeBadge outcome={verdict.outcome} />}
                    {score && <GroundingBadge grounding={score.grounding} score={score.score} />}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {tab === "skeptic" && !recordedRows && (
          <p className="note">
            Skeptic counter-checks quote the fixture answer. They stay hidden while discharge rows are live.
          </p>
        )}
        {tab === "skeptic" && recordedRows && (
          <ul className="stack">
            {skepticVerdicts.map((verdict) => {
              const claim = desk.answer.claims.find((item) => item.claim_id === verdict.claim_id);
              return (
                <li key={verdict.claim_id} className="step">
                  <OutcomeBadge outcome={verdict.outcome} />
                  <h3 title={claim?.text}>
                    {plainLanguage(claim?.text ?? "")} {marks(verdict.claim_id)}
                  </h3>
                  <p>{verdict.counter_check}</p>
                </li>
              );
            })}
          </ul>
        )}
        {tab === "judge" && judge && (
          <div className="stack">
            <div className="score-block">
              <p className="section-label">overall_score</p>
              <p className="figure">{judge.overall_score.toFixed(2)}</p>
              <div className="meter" aria-hidden="true">
                <span style={{ width: `${Math.max(0, Math.min(1, judge.overall_score)) * 100}%` }} />
              </div>
              <p className="note">
                Display only. The contract stores model_id. A routing name is shown as stored. A concrete
                Nightshift id says which model answered, and does not assign a lane. This screen did not call a
                model.
              </p>
            </div>
            {judge.claims.map((claim) => {
              const text = desk.answer.claims.find((item) => item.claim_id === claim.claim_id)?.text;
              return (
                <article key={claim.claim_id} className="step">
                  <div className="badge-row">
                    <GroundingBadge grounding={claim.grounding} score={claim.score} />
                    <span className="badge">{claim.numbers_match ? "numbers_match" : "numbers differ"}</span>
                    <span className="badge">
                      {claim.citation_faithful ? "citation_faithful" : "citation not faithful"}
                    </span>
                  </div>
                  <h3>
                    {text} {marks(claim.claim_id)}
                  </h3>
                  <p>{claim.rationale}</p>
                  <p className="note">{laneLabel(claim.model_id)}</p>
                </article>
              );
            })}
          </div>
        )}
        {tab === "judge" && !judge && <p className="note">This answer has no judge block.</p>}
      </div>
      <RefList refs={refs.refs} label="References in this answer" />
    </section>
  );
}

function OutcomeBadge({ outcome }: { outcome: SkepticOutcome }) {
  return <span className={`badge badge-${outcome}`}>{outcome}</span>;
}

export function GroundingBadge({ grounding, score }: { grounding: Grounding; score: number }) {
  return (
    <span className={`badge badge-${grounding}`}>
      {grounding} {score.toFixed(2)}
    </span>
  );
}
