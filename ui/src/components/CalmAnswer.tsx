import { useConsoleMaybe } from "../context/ConsoleContext";
import type { RecordedRun } from "../api/replay";
import { calmChip, calmOrder, detailClaims, ENGLISH_NOTE, horizonWord, isNonEnglish, officialLinks, type PlainAnswer } from "../lib/calmAnswer";
import { SafeLink } from "./SafeLink";
import { TechTrace } from "./TechTrace";
import { SourceBadges, SourceLegend } from "./SourceBadges";
import "../styles/calm.css";

/** The context sentence without its "For context, from the past:" lead-in (the card title says it). */
function contextBody(text: string): string {
  const body = text.replace(/^For context,?\s*(from the past:?)?\s*/i, "");
  return body.charAt(0).toUpperCase() + body.slice(1);
}

/** Put the cursor back in the question box of the Ask panel. */
function askAnother() {
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your question"]')?.focus();
}

/**
 * A quick or forecast answer in plain words (agents/floodsense_agents/plain.py builds every word by fixed
 * rules, no model). Citizens read headline, sentence, chip and disclaimer, with "Why" (the cited claims) folded
 * away. Insurers get the detailed claims first and the plain headline after them.
 * Rendered only for lane quick or forecast with a `plain` object (calmApplies).
 */
export function CalmAnswer({ run, plain }: { run: RecordedRun; plain: PlainAnswer }) {
  const role = useConsoleMaybe()?.deskRoute.role;
  const order = calmOrder(role);
  const chip = calmChip(plain);
  const claims = detailClaims(run);
  const hasSources = claims.some((c) => c.badges.length > 0);
  const claimList = (
    <>
      {hasSources && <SourceLegend />}
      <ul className="ask-claims">
        {claims.map(({ claim, flagged, badges }) => (
          <li key={claim.id}>
            {claim.text} {flagged && <strong className="note">[Flagged by Judge] </strong>}
            <SourceBadges items={badges} />
          </li>
        ))}
      </ul>
    </>
  );
  const links = officialLinks(plain);
  const head = (
    <section className="calm" aria-label="Answer in plain words">
      <p className="calm-meta">
        <span className={`plain-chip plain-chip--${chip.tone}`}>{chip.word}</span>
        <span className="calm-horizon">{horizonWord(plain)}</span>
      </p>
      <h3 className="calm-headline">{plain.headline}</h3>
      <p className="calm-line">{plain.oneLine}</p>
      {isNonEnglish(run.question) && <p className="note calm-lang">{ENGLISH_NOTE}</p>}
      <p className="note calm-disclaimer">{plain.disclaimer}</p>
      {order === "plain-first" && (
        <details className="disclosure calm-why">
          <summary>Why</summary>
          {claimList}
          <TechTrace run={run} embedded />
        </details>
      )}
      {plain.context && (
        <aside className="calm-context" aria-label="For context">
          <p className="calm-context-title">For context · from the past</p>
          <p>{contextBody(plain.context)}</p>
        </aside>
      )}
      <div className="calm-next">
        <p>{plain.nextStep}</p>
        <ul className="calm-links">
          {links.flatMap((group) =>
            group.links.map((link) => (
              <li key={link.url}>
                <SafeLink href={link.url}>{link.label}</SafeLink>
              </li>
            )),
          )}
        </ul>
        <button type="button" className="button" onClick={askAnother}>
          Ask about another place
        </button>
      </div>
    </section>
  );
  if (order === "plain-first") return head;
  return (
    <>
      <p className="ask-question">{run.summary}</p>
      {claimList}
      <TechTrace run={run} embedded />
      {head}
    </>
  );
}
