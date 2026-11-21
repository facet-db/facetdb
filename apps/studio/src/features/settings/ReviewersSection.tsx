import { Button } from "@facetdb/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useRef, useState } from "react";
import { ApiError, projectQuery } from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { whenWords } from "../decisions/index.ts";
import { CommandLine } from "../questions/index.ts";
import { Field, type FieldProblem } from "./Field.tsx";
import { reviewersQuery, studioAccessQuery } from "./queries.ts";
import { Unreachable } from "./Unreachable.tsx";
import { osUserOf } from "./words.ts";

/**
 * The reviewers: the accounts `facetdb users add` makes, listed, and a form that makes one through
 * `POST /v1/reviewers` with the same rules and the same words (the endpoint answers in them, and
 * the page shows its message and its fix as they come). There is no removing here: that stays
 * `facetdb users remove`, which asks for the name back.
 *
 * In the default install the worker's login may read the accounts and not write them, so the form
 * could only refuse, after a name and two passwords were typed. `GET /v1/studio` says beforehand
 * whether accounts can be made here; when they cannot, the page shows the terminal command instead,
 * with the name typed into it and a Copy. The owner's connection string is never asked for here: it
 * belongs in the terminal, not in a browser.
 *
 * The password is handled so that it lives as short a time as it can. It is typed into uncontrolled
 * boxes, so no state of the page holds it; at submit it is read once and the boxes are emptied; it
 * waits in one ref until the mutation's function takes it (and empties the ref) to build the
 * request, so it is never a mutation variable, never in the query cache, never in the address, and
 * a refused request leaves nothing of it behind: the person types it again.
 */

/** Which box a refusal belongs to; none when it is about the request as a whole. */
type Box = "name" | "password" | "confirm";
type Refusal = { readonly box: Box | undefined; readonly problem: FieldProblem };

/** The endpoint's codes that name a box; anything else is the request's. */
const BOX_OF_CODE: Readonly<Record<string, Box>> = {
  "invalid-name": "name",
  "user-exists": "name",
  "weak-password": "password",
};

function refusalOf(error: Error): Refusal {
  if (error instanceof ApiError) {
    return {
      box: BOX_OF_CODE[error.code],
      problem: { message: error.message, fix: error.fix },
    };
  }
  return {
    box: undefined,
    problem: {
      message: "The studio could not reach the worker, so no account was made.",
      fix: "Check that the worker is still running, then type the password again and add the reviewer.",
    },
  };
}

const NAME_RULE =
  "A lower-case letter, then 1 to 39 lower-case letters, digits, underscores or hyphens.";

function AddForm() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [local, setLocal] = useState<Refusal | undefined>(undefined);
  const password = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLInputElement>(null);
  // Where the typed password waits between the click and the request being built; nowhere else.
  const held = useRef("");

  const add = useMutation({
    // Only the name is a variable. The password is taken from `held` as the request is built.
    mutationFn: ({ name: account }: { readonly name: string }) => {
      const typed = held.current;
      held.current = "";
      return api.addReviewer(account, typed);
    },
    // The request is made even when the browser believes it is offline: this is the worker's own address.
    networkMode: "always",
    onSuccess: async () => {
      setName("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: reviewersQuery(api).queryKey }),
        queryClient.invalidateQueries({ queryKey: studioAccessQuery(api).queryKey }),
      ]);
    },
  });

  const refusal = local ?? (add.isError ? refusalOf(add.error) : undefined);
  const problemFor = (box: Box) => (refusal?.box === box ? refusal.problem : undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const typed = password.current?.value ?? "";
    const again = confirm.current?.value ?? "";
    const account = name.trim();
    const stop = (box: Box, message: string, fix: string) => {
      setLocal({ box, problem: { message, fix } });
    };
    if (account === "") {
      stop("name", "The account needs a name.", "Choose a name like maya or review-team.");
      return;
    }
    if (typed === "") {
      stop(
        "password",
        "The account needs a password.",
        "Type a password of at least 8 characters.",
      );
      return;
    }
    if (typed !== again) {
      stop(
        "confirm",
        "The two passwords are not the same, so nothing was sent.",
        "Type the same password in both boxes.",
      );
      return;
    }
    setLocal(undefined);
    held.current = typed;
    if (password.current !== null) {
      password.current.value = "";
    }
    if (confirm.current !== null) {
      confirm.current.value = "";
    }
    add.mutate({ name: account });
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <div className="grid gap-4 min-[760px]:grid-cols-3">
        <Field
          label="Name"
          help={NAME_RULE}
          problem={problemFor("name")}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <Field
          label="Password"
          help="At least 8 characters. It is stored hashed, and never shown again."
          problem={problemFor("password")}
          ref={password}
          type="password"
          autoComplete="new-password"
        />
        <Field
          label="Password again"
          problem={problemFor("confirm")}
          ref={confirm}
          type="password"
          autoComplete="new-password"
        />
      </div>
      {refusal !== undefined && refusal.box === undefined ? (
        <p role="alert" className="grid gap-1 border-l-2 border-no pl-3">
          <span>{refusal.problem.message}</span>
          <span className="text-text-2">{refusal.problem.fix}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={add.isPending}>
          {add.isPending ? "Adding" : "Add a reviewer"}
        </Button>
        <p role="status" className="max-w-[64ch] text-text-2">
          {add.isSuccess
            ? `Added the reviewer account "${add.variables.name}". Reviewers sign in with this name and password when the studio is opened on any address but this machine's.`
            : ""}
        </p>
      </div>
    </form>
  );
}

/** The account name rule, as `isUserName` of the users store spells it (NAME_RULE in words). */
const USER_NAME = /^[a-z][a-z0-9_-]{1,39}$/;

/**
 * The way accounts are made when this worker's login cannot write them: the command, with the
 * name filled in as it is typed once it is a name an account can have, and where it runs. The
 * CLI's words (`facetdb users add`); a name the CLI would refuse is refused here, at the box.
 */
function TerminalAdd() {
  const [name, setName] = useState("");
  const typed = name.trim();
  const named = USER_NAME.test(typed);
  const command = `DATABASE_URL=<owner-url> facetdb users add ${named ? typed : "<name>"}`;
  const problem: FieldProblem | undefined =
    typed === "" || named
      ? undefined
      : {
          message: `"${typed}" is not a name an account can have.`,
          fix: "Choose a name like maya or review-team.",
        };
  return (
    <div className="grid gap-4">
      <p className="m-0 max-w-[64ch]">
        Reviewer accounts are made from a terminal. The worker's login may read the accounts but not
        change them, which is how it is made, so this page cannot add one.
      </p>
      <div className="grid gap-4 min-[760px]:grid-cols-3">
        <Field
          label="Name"
          help={NAME_RULE}
          problem={problem}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </div>
      <div className="grid max-w-[64ch] gap-2">
        <p className="m-0 text-text-2">
          Run this where the worker runs, with <code>DATABASE_URL</code> set to the login{" "}
          <code>facetdb migrate</code> ran as (with a separate store database, the store's own
          login). It asks for the password twice and stores only its hash.
        </p>
        <CommandLine command={command} />
      </div>
    </div>
  );
}

export function ReviewersSection() {
  const api = useApi();
  const schedule = useSchedule();
  const accounts = useQuery(reviewersQuery(api));
  const access = useQuery(studioAccessQuery(api));
  const me = useQuery(projectQuery(api)).data?.reviewer;
  const headingId = useId();
  const now = new Date(schedule.now());
  const osUser = me === undefined ? undefined : osUserOf(me);
  return (
    <section aria-labelledby={headingId} className="grid gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="text-lg font-bold tracking-tight">
          Reviewers
        </h2>
        <span className="text-[13px] text-text-2">
          {access.data?.accountsWritable === false
            ? "Local accounts, made with facetdb users add."
            : "Local accounts, made here or with facetdb users add."}
        </span>
      </div>
      {accounts.isError ? (
        <Unreachable
          what="The reviewer accounts"
          error={accounts.error}
          lastKnownAt={accounts.data === undefined ? undefined : accounts.dataUpdatedAt}
          now={now}
          retry={() => {
            void accounts.refetch();
          }}
        />
      ) : null}
      {accounts.data === undefined ? (
        accounts.isError ? null : (
          <p role="status" className="text-text-2">
            Reading the accounts.
          </p>
        )
      ) : (
        <>
          <ul aria-labelledby={headingId} className="grid">
            {osUser === undefined ? null : (
              <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-hairline py-3 first:border-t-0 first:pt-0">
                <span>
                  <strong>{osUser}</strong>, you, from this computer
                </span>
                <span className="text-[13px] text-text-2">decides as {me}</span>
              </li>
            )}
            {accounts.data.map((account) => (
              <li
                key={account.name}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-hairline py-3 first:border-t-0 first:pt-0"
              >
                <span>
                  <strong>{account.name}</strong>, account{account.name === me ? ", you" : ""}
                </span>
                <span className="text-[13px] text-text-2">
                  {account.name === me
                    ? `decides as ${account.name}`
                    : `added ${whenWords(new Date(account.createdAt), now)}`}
                </span>
              </li>
            ))}
          </ul>
          {accounts.data.length === 0 ? (
            <p className="text-text-2">
              No reviewer accounts yet, so only this computer can open the studio.
            </p>
          ) : null}
        </>
      )}
      {/*
        The form only once the access read says accounts can be made here; while it reads, nothing
        to type into; when it failed, the terminal route, which always works.
      */}
      {access.data === undefined ? (
        access.isError ? (
          <TerminalAdd />
        ) : (
          <p role="status" className="text-text-2">
            Reading how accounts are made.
          </p>
        )
      ) : access.data.accountsWritable ? (
        <AddForm />
      ) : (
        <TerminalAdd />
      )}
    </section>
  );
}
