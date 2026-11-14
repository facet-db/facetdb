// The refusal `open` throws is core's (the contract's); re-exported here for callers of this
// package, so the engine and the type it throws come through one door.
export { EngineRefusal } from "@facetdb/core";
export { createPostgresEngine, type PostgresEngineOptions, postgresEngine } from "./engine.ts";
