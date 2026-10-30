import "../../styles/sponsors.css";
import type { StackData } from "../../hooks/useStackData";
import { agoPhrase, foldPlace, WEB_NOT_WARNING, webCheckView, webContextOf } from "../../lib/sponsors";
import { SafeLink } from "../SafeLink";
import { DataBadge } from "../stack/StackBits";
import { DeskCard } from "./DeskPage";

/** Pure: does the run answer about this place? The run states its question; a place name in it (or in its summary) is the match. */
export function runMatchesPlace(run: { question?: string | null; summary: string }, place: string | null | undefined): boolean {
  const p = foldPlace((place ?? "").trim());
  return p.length > 0 && foldPlace(`${run.question ?? ""} ${run.summary}`).includes(p);
}

/**
 * Evidence slot: the Tavily web check of the NEWEST CHECKED ANSWER (not necessarily the place on screen), labelled as such.
 * Citizens: words and links only, and only when that answer is about the selected `place`; otherwise the empty state.
 * Insurer and operator also see the call detail. No run, or no web call: an honest empty state.
 */
export function WebCheckCard({ stack, desk, place }: { stack: StackData; desk: "citizen" | "insurer" | "operator"; place?: string | null }) {
  const run = stack.stackRun;
  const citizen = desk === "citizen";
  const shown = run && (!citizen || runMatchesPlace(run.run, place)) ? run : null;
  const v = webCheckView(shown ? webContextOf(shown.raw) : null);
  const detailed = !citizen;
  const ago = shown ? agoPhrase(webContextOf(shown.raw)?.retrieved_at) : null;
  const what = shown ? shown.run.eventId ?? (citizen ? place : null) ?? "place not stated" : null;
  return (
    <DeskCard label="Web check · Tavily" title="Was this checked against the web?">
      {run && !shown && <p className="note">The latest checked answer is about another place, so no web check is shown for this one.</p>}
      {shown && (
        <p className="note">
          {citizen
            ? `From the latest checked answer${place ? ` for ${place}` : ""}${ago ? `, checked ${ago}` : ""}. `
            : `From the latest checked answer (${what}, ${webContextOf(shown.raw)?.retrieved_at ?? "time not stated"}) `}
          <DataBadge kind={shown.kind} />
        </p>
      )}
      <p>{v.headline}</p>
      {detailed && v.detail && (
        <p className="note">
          {v.detail}
          {v.retrievedAt ? ` · retrieved ${v.retrievedAt}` : ""}
        </p>
      )}
      {v.links.length > 0 && (
        <ul className="webcheck-links">
          {v.links.map((l) => (
            <li key={l.url}>
              <SafeLink href={l.url}>{l.title}</SafeLink>
            </li>
          ))}
        </ul>
      )}
      <p className="note">{WEB_NOT_WARNING}.</p>
    </DeskCard>
  );
}
