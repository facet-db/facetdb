import { Button, StatusWord } from "@facetdb/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useId } from "react";
import { ApiError, projectQuery } from "../../api/index.ts";
import { useApi, useDeps } from "../../deps.tsx";
import { studioAccessQuery } from "./queries.ts";
import { Unreachable } from "./Unreachable.tsx";
import { accountNamed, accountsWords, listensWords } from "./words.ts";

/**
 * Studio access in words, from `GET /v1/studio`: where the studio listens, whether that is this
 * computer alone, and how many reviewer accounts exist; and who the viewer is, with the way out
 * when they signed in. On this computer, with no account, there is nothing to sign out of and the
 * page says so rather than show a button that does nothing.
 */

function SignOut({ account }: { readonly account: string }) {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: () => api.signOut(),
    onSuccess: () => {
      // Everything cached was read as this reviewer: none of it outlives the session.
      queryClient.clear();
      void router.navigate({ to: "/sign-in", search: { next: undefined } });
    },
  });
  return (
    <div className="grid justify-items-start gap-3">
      <p>
        You are signed in as <strong>{account}</strong>.
      </p>
      <Button onClick={() => signOut.mutate()} disabled={signOut.isPending}>
        {signOut.isPending ? "Signing out" : "Sign out"}
      </Button>
      {signOut.isError ? (
        <p role="alert" className="grid gap-1 border-l-2 border-no pl-3">
          {signOut.error instanceof ApiError ? (
            <>
              <span>{signOut.error.message}</span>
              <span className="text-text-2">{signOut.error.fix}</span>
            </>
          ) : (
            // The browser's own text ("Failed to fetch") says nothing a person can act on.
            <>
              <span>The worker could not be reached, so you are still signed in.</span>
              <span className="text-text-2">
                Check that the worker is still running and that this computer is online, then sign
                out again.
              </span>
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}

export function AccessSection() {
  const api = useApi();
  const { schedule, origin } = useDeps();
  const reachedAt = new URL(origin).host;
  const access = useQuery(studioAccessQuery(api));
  const me = useQuery(projectQuery(api)).data?.reviewer;
  const headingId = useId();
  const account = me === undefined ? null : accountNamed(me);
  const now = new Date(schedule.now());
  return (
    <section aria-labelledby={headingId} className="grid gap-4">
      <h2 id={headingId} className="text-lg font-bold tracking-tight">
        Studio access
      </h2>
      {access.isError ? (
        <Unreachable
          what="Who may open the studio"
          error={access.error}
          lastKnownAt={access.data === undefined ? undefined : access.dataUpdatedAt}
          now={now}
          retry={() => {
            void access.refetch();
          }}
        />
      ) : null}
      {access.data === undefined ? (
        access.isError ? null : (
          <p role="status" className="text-text-2">
            Reading how the studio is opened.
          </p>
        )
      ) : access.data.loopback ? (
        <div className="grid justify-items-start gap-3">
          <p className="max-w-[64ch]">
            This studio is open at <code>{reachedAt}</code> and listens on{" "}
            <code>{listensWords(access.data.host)}</code>: this computer only, no login. To open it
            to reviewers on your network, start the worker with <code>--host 0.0.0.0</code>; it
            refuses until at least one reviewer account exists, and then every visitor signs in.
            There {access.data.reviewers === 1 ? "is" : "are"}{" "}
            {accountsWords(access.data.reviewers)} now.
          </p>
          <StatusWord status="done" size="small" label="Loopback only" />
        </div>
      ) : (
        <div className="grid justify-items-start gap-3">
          <p className="max-w-[64ch]">
            This studio is open at <code>{reachedAt}</code> and listens on{" "}
            <code>{listensWords(access.data.host)}</code>, so other computers can reach it. A
            visitor from another computer signs in with a reviewer account; there{" "}
            {access.data.reviewers === 1 ? "is" : "are"} {accountsWords(access.data.reviewers)}. A
            browser on this computer needs no login.
          </p>
          <StatusWord status="information" size="small" label="Open to the network" />
        </div>
      )}
      {me === undefined ? null : account === null ? (
        <p className="max-w-[64ch] text-text-2">
          You are on this computer, deciding as <code>{me}</code>, so there is nothing to sign out
          of.
        </p>
      ) : (
        <SignOut account={account} />
      )}
    </section>
  );
}
