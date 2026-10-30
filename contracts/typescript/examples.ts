/**
 * Assigns the JSON examples to the TypeScript mirrors.
 * `python tasks.py lint` typechecks this file. Schema tests remain the strict gate.
 *
 * JSON imports widen enums to `string`, so this checks keys and value kinds.
 * Enum values are enforced by the schema tests, not by this assignment.
 */

import type { Answer, Approval, Citation, Claim, Evidence, Judge, Plain, PlaybookAction, WatchEvent } from "./index";

type Wire<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends null
        ? null
        : T extends ReadonlyArray<infer U>
          ? ReadonlyArray<Wire<U>>
          : T extends object
            ? { [K in keyof T]: Wire<T[K]> }
            : T;

import answerLive from "../examples/answer_live.json" with { type: "json" };
import answerReplay from "../examples/answer_replay.json" with { type: "json" };
import approval from "../examples/approval.json" with { type: "json" };
import citation from "../examples/citation.json" with { type: "json" };
import claim from "../examples/claim.json" with { type: "json" };
import evidence from "../examples/evidence.json" with { type: "json" };
import judge from "../examples/judge.json" with { type: "json" };
import plain from "../examples/plain.json" with { type: "json" };
import playbookAction from "../examples/playbook_action.json" with { type: "json" };
import watchEvent from "../examples/watch_event.json" with { type: "json" };

export const exampleClaim: Wire<Claim> = claim;
export const exampleEvidence: Wire<Evidence> = evidence;
export const exampleCitation: Wire<Citation> = citation;
export const exampleJudge: Wire<Judge> = judge;
export const examplePlaybookAction: Wire<PlaybookAction> = playbookAction;
export const exampleApproval: Wire<Approval> = approval;
export const exampleWatchEvent: Wire<WatchEvent> = watchEvent;
export const exampleAnswerLive: Wire<Answer> = answerLive;
export const exampleAnswerReplay: Wire<Answer> = answerReplay;
export const examplePlain: Wire<Plain> = plain;
