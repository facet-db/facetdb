import { Button } from "@facetdb/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { ApiError } from "../api/index.ts";
import { useDeps } from "../deps.tsx";
import { Brand, PageHead } from "../shell/index.ts";
import { rootRoute } from "./root.tsx";

/**
 * The sign-in page: shown when the API answers `sign-in`, which it does to a browser on another
 * machine without a session. On the machine that runs the worker nobody sees it. It sits outside
 * the shell: the rail's data is the reviewer's.
 */

/** A space or anything below it, or DEL: a URL parser strips some of them (`/\t/evil` is `//evil`). */
function hasControlOrSpace(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x21 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `next` reads as a plain path of this site: it starts with one `/` and no `\`, holds no
 * control character or space, and is not the sign-in page itself.
 */
function plainPath(next: unknown): next is string {
  return (
    typeof next === "string" &&
    next.startsWith("/") &&
    !next.startsWith("//") &&
    !next.startsWith("/\\") &&
    !hasControlOrSpace(next) &&
    !next.startsWith("/sign-in")
  );
}

/**
 * A path inside the app to go back to once signed in, never another site. The text checks of
 * `plainPath` come first; then the path is resolved as a browser would against the page's origin
 * and kept only if it stays on that origin, so the check holds without trusting pushState to refuse.
 */
export function returnPath(next: unknown, origin: string): string | undefined {
  if (!plainPath(next)) {
    return undefined;
  }
  try {
    return new URL(next, origin).origin === origin ? next : undefined;
  } catch {
    return undefined;
  }
}

export const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  // Set even when refused: the router keeps the raw value of a key the validator leaves out. The
  // origin check runs where the path is used, with the page's origin from the dependencies.
  validateSearch: (search: Record<string, unknown>): { next: string | undefined } => {
    const next = search["next"];
    return { next: plainPath(next) ? next : undefined };
  },
  component: SignInPage,
});

const fieldClasses =
  "h-9 w-full border border-hairline bg-transparent px-3 text-text outline-offset-2 focus-visible:outline-2 focus-visible:outline-facet-text";

function SignInPage() {
  const { api, origin } = useDeps();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { next } = signInRoute.useSearch();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const nameId = useId();
  const passwordId = useId();
  const signIn = useMutation({
    mutationFn: (account: { readonly name: string; readonly password: string }) =>
      api.signIn(account.name, account.password),
    onSuccess: () => {
      // Every answer cached before was a refusal: the pages ask again as this reviewer.
      queryClient.clear();
      router.history.push(returnPath(next, origin) ?? "/");
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    signIn.mutate({ name, password });
  };
  const failure = signIn.error;
  return (
    <main className="mx-auto grid max-w-[420px] gap-6 px-4 py-16">
      <Brand />
      <div>
        <PageHead
          title="Sign in"
          lede="This studio is open to other machines, so it asks who you are. Your account is made with facetdb users add on the machine that runs the worker."
        />
        <form className="grid gap-4" onSubmit={submit}>
          <label className="grid gap-1.5" htmlFor={nameId}>
            <span className="text-[13px] text-text-2">Name</span>
            <input
              id={nameId}
              className={fieldClasses}
              autoComplete="username"
              required
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </label>
          <label className="grid gap-1.5" htmlFor={passwordId}>
            <span className="text-[13px] text-text-2">Password</span>
            <input
              id={passwordId}
              className={fieldClasses}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          </label>
          {failure === null ? null : (
            <p role="alert" className="grid gap-1 border-l-2 border-no pl-3">
              <span>{failure.message}</span>
              {failure instanceof ApiError ? (
                <span className="text-text-2">{failure.fix}</span>
              ) : null}
            </p>
          )}
          <div>
            <Button type="submit" variant="primary" disabled={signIn.isPending}>
              {signIn.isPending ? "Signing in" : "Sign in"}
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
