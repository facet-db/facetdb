/**
 * The fakes every core test uses, and the connector contract suite other packages import
 * (`@facetdb/core/testing`). Nothing here runs in production; tests pass these through the same
 * parameters the composition root fills with real adapters.
 */
export { type ActionCall, FakeAction } from "./action.ts";
export { type Delivery, FakeChannel } from "./channel.ts";
export { FakeClock } from "./clock.ts";
export { FakeConnector, FakeDatabase, type FakeDatabaseOptions } from "./connector.ts";
export {
  type ContractFixture,
  type ContractOptions,
  runConnectorContract,
} from "./contract-suite.ts";
export { FakeStore } from "./store.ts";
