import { createSlackPlugin, type Fetch } from "@facetdb/slack";

/**
 * The project's `@facetdb/slack` in the triage example's end to end: the real plugin, built through
 * `createSlackPlugin({ fetch })` as its own tests build it, and the config file's real `slack`
 * helper. An incoming-webhook URL must be https on hooks.slack.com, a check that stays as it is;
 * this `fetch` carries a request for hooks.slack.com to the webhook receiver on this machine, whose
 * address the e2e gives the CLI in `TRIAGE_E2E_SLACK`, and refuses any other host: nothing reaches
 * the network. Loaded by the CLI in its child process, through the project's node_modules, only.
 */

export { slack } from "@facetdb/slack";

const HOOKS = "https://hooks.slack.com";

function loopbackOf(variable: string): string {
  const address = process.env[variable];
  if (address === undefined || !address.startsWith("http://127.0.0.1:")) {
    throw new Error(
      `${variable} names no server on this machine: this plugin runs under triage-example.e2e.test.ts only`,
    );
  }
  return address;
}

const receiver = loopbackOf("TRIAGE_E2E_SLACK");

const onLoopback: Fetch = (url, init) => {
  const target = new URL(url);
  if (target.origin !== HOOKS) {
    return Promise.reject(new TypeError(`the triage e2e reaches ${HOOKS} alone`));
  }
  return globalThis.fetch(`${receiver}${target.pathname}`, init);
};

export default createSlackPlugin({ fetch: onLoopback });
