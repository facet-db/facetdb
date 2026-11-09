// Through the package's own `./testing` export, as @facetdb/postgres imports it: a broken export
// fails here, not first in another package.
import { FakeConnector, FakeDatabase, runConnectorContract } from "@facetdb/core/testing";

/**
 * The connector contract, run against the in-memory fake. Every real connector runs the same suite
 * through its own factory; a case that passes here and fails there is an adapter bug.
 */
runConnectorContract(async () => {
  const database = new FakeDatabase({ fields: ["title", "body"], pageSize: 10 });
  return {
    connector: new FakeConnector(database),
    peer: new FakeConnector(database),
    edit: (key, state) => {
      database.edit(key, state);
      return Promise.resolve();
    },
    fields: database.fields,
    decisionOf: (key) => Promise.resolve(database.decisionOf(key)),
  };
});
