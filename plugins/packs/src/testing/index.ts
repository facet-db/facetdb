/**
 * The packs' test helpers: the checks every pack's committed sample meets. Imported by the packs'
 * tests alone, never by `../index.ts`; under `testing/`, so the published package leaves them out
 * with the other test files.
 */
export {
  contactProblems,
  labelsOf,
  readSample,
  type Sample,
  type SampleRecord,
  shapeProblems,
  sharedWording,
  textOf,
  wordingOf,
  wordRuns,
} from "./sample-checks.ts";
