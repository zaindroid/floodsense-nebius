import type { ApprovalStatus } from "../types/contract";

/** The HITL guard. Reject and Edit need a note; Approve does not. Null means the decision can be recorded. */
export function decisionNoteError(status: ApprovalStatus, note: string): string | null {
  if (note.trim().length > 0) return null;
  if (status === "rejected") return "A note is required to reject.";
  if (status === "edited") return "Add a note to record the edit.";
  return null;
}

/** Citizens see playbook actions only after a human approved them, as is or edited. */
export function actionsVisibleToCitizen(status: ApprovalStatus): boolean {
  return status === "approved" || status === "edited";
}
