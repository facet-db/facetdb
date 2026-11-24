// The refusal `open` throws is core's (the contract's); re-exported here for callers of this
// package, so the engine and the type it throws come through one door.
export { EngineRefusal } from "@facetdb/core";
// The store door's doctor checks open their connections as the engine's do.
export { connectTimedOut, DOCTOR_CONNECT_TIMEOUT_S, serverDidNotAnswer } from "./doctor.ts";
export { createPostgresEngine, type PostgresEngineOptions, postgresEngine } from "./engine.ts";
