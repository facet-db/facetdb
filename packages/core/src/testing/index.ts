/**
 * The fakes every core test uses, the fake database engine the CLI's tests use, and the connector
 * contract suite other packages import (`@facetdb/core/testing`). Nothing here runs in production;
 * tests pass these through the same parameters the composition root fills with real adapters.
 */
export { type ActionCall, FakeAction } from "./action.ts";
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
export { FakeStore } from "./store.ts";
