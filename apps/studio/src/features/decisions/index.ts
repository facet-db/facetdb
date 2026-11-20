// The Decisions feature's door: the page, the view the address holds, and the parts the why page of
// a record shares with it (a problem in words, a time and its zone, and the stale-rows notice).
export { Problem, StaleNote } from "./controls.tsx";
export { DecisionsPage } from "./DecisionsPage.tsx";
export { Moment, ZoneNote } from "./Moment.tsx";
export type { DecisionsPatch, DecisionsSearch } from "./search.ts";
export { decisionsSearch, patched } from "./search.ts";
export { whenWords } from "./when.ts";
