import type { ReviewEndpointService } from "./service.ts";

/** For a test of another surface that builds the app: any review call is a mistake in that test. */
export const NO_REVIEW: ReviewEndpointService = {
  queue: () => Promise.reject(new Error("this test reads no review queue")),
  open: () => Promise.reject(new Error("this test opens no card")),
  renew: () => Promise.reject(new Error("this test renews no card")),
  decide: () => Promise.reject(new Error("this test decides no card")),
  skip: () => Promise.reject(new Error("this test skips no card")),
  release: () => Promise.reject(new Error("this test releases no card")),
  undo: () => Promise.reject(new Error("this test undoes nothing")),
  // A sign-out forgets the reviewer's undo, and a test of another surface may sign out.
  forget: () => undefined,
};
