/**
 * Wire types shared with agents and the API.
 * Field names stay snake_case. This file only re-exports the contract.
 *
 * The relative path leaves the ui/ Docker build context (compose builds ./ui).
 * Vite erases `import type`, so the dev server in that image does not read the file.
 * `tsc` from a full checkout resolves it. Do not copy contracts into ui/.
 * ModelId lives in contracts/typescript. A routing name is shown as stored.
 * A concrete Nightshift id is labelled as the model that answered. This file does not choose a lane.
 */
export type {
  Answer,
  Approval,
  ApprovalStatus,
  Citation,
  Claim,
  Evidence,
  Grounding,
  Judge,
  JudgeClaim,
  PlaybookAction,
  ServedFrom,
} from "../../../contracts/typescript/index";
