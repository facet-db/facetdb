import { createGithubPlugin, DEFAULT_API_URL, type GithubFetch } from "../../index.ts";

/**
 * The project's `@facetdb/github` in the triage example's end to end: the real plugin, built
 * through `createGithubPlugin({ fetch })` as its own tests build it, and the config file's real
 * `github` helper. Its `fetch` carries a request for GitHub's API (`https://api.github.com`, the
 * address the example leaves as it is) to the scripted GitHub on this machine, whose address the
 * e2e gives the CLI in `TRIAGE_E2E_GITHUB`, and refuses any other host: nothing reaches the
 * network. Loaded by the CLI in its child process, through the project's node_modules, only.
 */

export { github } from "../../index.ts";

const API = new URL(DEFAULT_API_URL).origin;

function loopbackOf(variable: string): string {
  const address = process.env[variable];
  if (address === undefined || !address.startsWith("http://127.0.0.1:")) {
    throw new Error(
      `${variable} names no server on this machine: this plugin runs under triage-example.e2e.test.ts only`,
    );
  }
  return address;
}

const loopback = loopbackOf("TRIAGE_E2E_GITHUB");

const onLoopback: GithubFetch = (url, init) => {
  const target = new URL(url);
  if (target.origin !== API) {
    return Promise.reject(new TypeError(`the triage e2e reaches ${API} alone`));
  }
  return globalThis.fetch(`${loopback}${target.pathname}${target.search}`, init);
};

export default createGithubPlugin({
  fetch: onLoopback,
  now: () => Date.now(),
  warn: (line) => {
    process.stderr.write(`warning: ${line}\n`);
  },
});
