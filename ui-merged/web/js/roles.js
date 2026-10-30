// Three people FloodSense serves. The role changes what each page puts first and
// how the agents word their answer (context.role), never what is true.

export const ROLES = {
  citizen: {
    label: "Citizen",
    api: "citizen",
    watchNav: "My area",
    decide: false,
    sub: "Check the river near you in plain words. Every number shows where it came from.",
    cta: [["Check my area", "#/watch"], ["Ask a question", "#/ask"]],
    watchTitle: "Is my area at risk?",
    watchIntro: "Find your town or river. Each place shows how its water compares with its usual level.",
    askIntro: "Ask in plain words. You get a short answer, what to do, and where each number came from.",
    questions: [
      { q: "Is the Rhine at Köln rising right now?", when: "now", place: "Köln" },
      { q: "Is Paiporta at risk of flooding right now?", when: "now", place: "Paiporta" },
      { q: "What happened in Paiporta on 29 October 2024?", when: "valencia", place: "Paiporta" },
    ],
  },
  insurer: {
    label: "Insurer",
    api: "insurer",
    watchNav: "Insured sites",
    decide: true,
    sub: "See which insured sites a flood reaches, with cited evidence and actions your analyst approves.",
    cta: [["Check exposure", "#/watch"], ["Ask the agents", "#/ask"]],
    watchTitle: "Your insured sites and the rivers near them",
    watchIntro: "Insured sites inside the flood footprint first, then every river FloodSense reads.",
    askIntro: "Ask about exposure. The answer leads with the insured sites at risk and cites every number.",
    decideTitle: "Actions for your insured sites",
    decideIntro: "Adjuster visits, policyholder alerts and notices wait for your sign-off.",
    reviewer: "insurer analyst",
    questions: [
      { q: "Why are our Valencia sites at risk?", when: "valencia", place: "Paiporta" },
      { q: "Which insured sites sat inside the flood footprint?", when: "valencia", place: "Valencia" },
      { q: "What was known by 15:00 UTC on 14 July 2021?", when: "ahr", place: "Ahrweiler" },
    ],
  },
  civil: {
    label: "Civil protection",
    api: "operator",
    watchNav: "Where to act",
    decide: true,
    sub: "See where rivers are rising across Europe, and sign off every public notice before it goes out.",
    cta: [["See where to act", "#/watch"], ["Review actions", "#/decide"]],
    watchTitle: "Where to act first",
    watchIntro: "Places well above their usual level come first, with the trend and where each number comes from.",
    askIntro: "Ask for a briefing. Every line comes from a stated source; the agents never issue a warning of their own.",
    decideTitle: "Notices and actions to sign off",
    decideIntro: "Public notices and response actions wait for a duty officer.",
    reviewer: "civil protection duty officer",
    questions: [
      { q: "Where in Europe are rivers above their usual level today?", when: "now", place: null },
      { q: "When did the river peak at Paiporta, and what warned of it first?", when: "valencia", place: "Paiporta" },
      { q: "Which places on the Ahr flooded first in July 2021?", when: "ahr", place: "Ahrweiler" },
    ],
  },
};

const KEY = "fs.role";
export function role() {
  const r = localStorage.getItem(KEY);
  return ROLES[r] ? r : "insurer";
}
export function setRole(r) {
  if (ROLES[r]) localStorage.setItem(KEY, r);
}

// The past floods the agents can replay, and "now" for live data.
export const WHEN = {
  now: { label: "Now (live)", event_id: null, replay_ts: null },
  valencia: { label: "Valencia, Oct 2024", event_id: "EMSR773", replay_ts: "2024-10-29T18:00:00Z" },
  ahr: { label: "Ahr valley, Jul 2021", event_id: "EMSR517", replay_ts: "2021-07-14T15:00:00Z" },
};
