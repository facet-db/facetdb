// The test helpers' door: the fake API client and its samples, and the render of the whole studio
// over fakes. Nothing here is part of the build.
export type { FakeApi } from "./fake-client.ts";
export {
  fakeApi,
  SAMPLE_HOME,
  SAMPLE_PROJECT,
  SAMPLE_QUEUE,
  signInRequired,
  unexpected,
} from "./fake-client.ts";
export type { RenderStudioOptions } from "./render.tsx";
export { fakeMedia, memoryStorage, renderStudio, STUDIO_ORIGIN } from "./render.tsx";
