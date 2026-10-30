import { describe, expect, it } from "vitest";
import { actionsVisibleToCitizen, decisionNoteError } from "./decision";

describe("decisionNoteError", () => {
  it("requires a note to reject or edit", () => {
    expect(decisionNoteError("rejected", "")).toBe("A note is required to reject.");
    expect(decisionNoteError("edited", "")).toBe("Add a note to record the edit.");
  });

  it("treats a blank note as no note", () => {
    expect(decisionNoteError("rejected", "   \n")).not.toBeNull();
    expect(decisionNoteError("edited", "\t")).not.toBeNull();
  });

  it("lets a decision with a note through", () => {
    expect(decisionNoteError("rejected", "Footprint is out of date")).toBeNull();
    expect(decisionNoteError("edited", "Narrowed to VAL01")).toBeNull();
  });

  it("does not require a note to approve", () => {
    expect(decisionNoteError("approved", "")).toBeNull();
  });
});

describe("actionsVisibleToCitizen", () => {
  it("shows actions only after a human approved them", () => {
    expect(actionsVisibleToCitizen("pending")).toBe(false);
    expect(actionsVisibleToCitizen("rejected")).toBe(false);
    expect(actionsVisibleToCitizen("approved")).toBe(true);
    expect(actionsVisibleToCitizen("edited")).toBe(true);
  });
});
