// The test helpers' door: the fake API client and its samples, and the render of the whole studio
// over fakes. Nothing here is part of the build.
export type { FakeApi } from "./fake-client.ts";
export {
  fakeApi,
  SAMPLE_ACCESS,
  SAMPLE_ALERTS,
  SAMPLE_CARD,
  SAMPLE_DECISIONS,
  SAMPLE_HOME,
  SAMPLE_PROJECT,
  SAMPLE_QUEUE,
  SAMPLE_REVIEWERS,
  SAMPLE_RUNS,
  SAMPLE_SOURCE_NAMES,
  SAMPLE_SPENDING_CONFIG,
  sampleHistory,
  signInRequired,
  unexpected,
} from "./fake-client.ts";
export type { FakeScheduler } from "./fake-scheduler.ts";
export { FAKE_START, fakeScheduler } from "./fake-scheduler.ts";
export type { RenderStudioOptions } from "./render.tsx";
export { fakeMedia, memoryStorage, renderStudio, STUDIO_NOW, STUDIO_ORIGIN } from "./render.tsx";
