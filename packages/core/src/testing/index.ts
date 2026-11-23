/**
 * The fakes every core test uses, the fake database engine the CLI's tests use, the connector
 * contract suite other packages import (`@facetdb/core/testing`), and the labelled-sample run the
 * question packs' live tests share. Nothing here runs in production; tests pass these through the
 * same parameters the composition root fills with real adapters.
 */
export { type ActionCall, FakeAction } from "./action.ts";
export { FakeAlertStore } from "./alert-store.ts";
export { type Delivery, FakeChannel } from "./channel.ts";
export { FakeClock } from "./clock.ts";
export { FakeConnector, FakeDatabase, type FakeDatabaseOptions } from "./connector.ts";
export {
  CONTRACT_QUESTIONS,
  type ContractFixture,
  type ContractOptions,
  runConnectorContract,
} from "./contract-suite.ts";
export { FakeDecisionLog } from "./decision-log.ts";
export {
  FakeEngine,
  type FakeEngineOptions,
  FakeOpenConnector,
  type FakePlans,
  type FakeRun,
  type FakeStop,
} from "./engine.ts";
export { FakeReviewQueue } from "./review-queue.ts";
export { FakeRunLog } from "./run-log.ts";
export {
  type LabelledRecord,
  type LabelledSample,
  type Outcome,
  type QuestionResult,
  type ReportOptions,
  runSample,
  type SampleRun,
  type SampleRunOptions,
  type SampleSubset,
  sampleReport,
  type Tally,
  tally,
} from "./sample-run.ts";
export { FakeStore } from "./store.ts";
export { FakeVersionModels, freshHeldModel } from "./version-models.ts";
