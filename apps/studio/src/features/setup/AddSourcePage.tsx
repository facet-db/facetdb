import { Button, buttonClasses, Listbox, ScrollRegion, StatusWord } from "@facetdb/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  type DraftPreview,
  type Inspection,
  type SetupDraft,
  type SetupInstalled,
  type SetupPlan,
  type SourceDraft,
} from "../../api/index.ts";
import { useApi } from "../../deps.tsx";
import { PageHead } from "../../shell/index.ts";
import { Problem } from "../decisions/index.ts";
import {
  CONFIG_KEY,
  countWords,
  dollarWords,
  figuresFor,
  floorDollarWords,
  formHolds,
  nameProblem,
  newQuestion,
  PreviewPanel,
  previewKey,
  projectConfigQuery,
  QuestionEditor,
  QuestionThresholds,
  ReplaceAnyway,
  type SourceForm,
  TextField,
  usePreview,
} from "../questions/index.ts";
import { aboutRows, BackfillControls, sourcesQuery } from "../sources/index.ts";
import {
  durationWords,
  firstRead,
  nameFromTable,
  type SetupChoices,
  type Storage,
  setupDraftOf,
  sourceNameProblem,
  sourcePart,
  tableProblem,
  variableProblem,
} from "./choices.ts";
import { Check, ConnectionField, Step, Waiting } from "./fields.tsx";
import { type InstallFailure, installFailure } from "./outcome.ts";

/**
 * Add a source: six numbered steps on one page. Connect with an admin connection string; pick the
 * table and the columns the model reads, with five rows as it will see them; write the questions
 * with the live preview; set the thresholds over the preview's answers; choose where the answers go
 * and the variable the worker connects with; read the install SQL and the config file's diff, then
 * run it.
 *
 * The admin connection string lives in this page's memory alone (a ref, never state a query or a
 * mutation keeps): it is sent in the body of each of the setup's requests, never shown again after
 * step one, and forgotten when the page is left or reloaded, after the install, or when the person
 * connects anew. Every call that spends or changes something is the person's click: the preview's
 * rule is the Questions page's (a first click, then 1.5 seconds after an edit of what the model
 * reads); the plan is asked by "Show the SQL"; the install runs only the plan on screen, once.
 */

/** A draft as one string: the plan on screen is the plan of this draft, or it is not shown. */
const keyOf = (draft: SetupDraft | undefined): string =>
  draft === undefined ? "" : JSON.stringify(draft);

/**
 * The worker's words, which follow "source: ", as a sentence of their own: the first letter up,
 * unless the first word is a file name or an identifier (facetdb.config.ts, SELLERS_URL), which
 * keeps its case.
 */
const sentence = (text: string): string =>
  /^[a-z]+(\s|$)/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text;

/** The first form: one yes or no question, named so it can be renamed. */
function firstForm(name: string): SourceForm {
  const empty: SourceForm = { name, questions: [], thresholdOrder: [] };
  return { ...empty, questions: [newQuestion(empty)] };
}

const STORAGE_WORDS = (table: string): Record<Storage, string> => {
  const bare = table.slice(table.lastIndexOf(".") + 1);
  return {
    inline: `Columns on ${table}`,
    "side-table": `A side table, facetdb.${bare}_answers, with a view ${bare}_with_answers`,
  };
};

/** The column a sampled value is shown under: its text, cut by the cell, whole on hover. */
function SampleRows({
  table,
  read,
}: {
  readonly table: NonNullable<Inspection["table"]>;
  readonly read: readonly string[];
}) {
  const id = useId();
  if (read.length === 0) {
    return null;
  }
  return (
    <div className="grid gap-2">
      <p id={id} className="text-[13px] text-text-2">
        {`${table.rows.length === 0 ? "No rows yet" : `${countWords(table.rows.length)} sample rows`}, as the model will see them`}
      </p>
      {table.rows.length === 0 ? null : (
        <div className="overflow-x-auto border border-hairline">
          <table aria-labelledby={id} className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {read.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className="border-b border-l border-hairline px-3 py-2 text-left font-mono font-medium text-text-2 first:border-l-0"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a sample row has no identity but its place
                <tr key={index}>
                  {read.map((column) => {
                    const value = row[column] ?? null;
                    return (
                      <td
                        key={column}
                        title={value ?? undefined}
                        className="max-w-[36ch] truncate border-t border-l border-hairline px-3 py-2 first:border-l-0"
                      >
                        {value ?? <span className="text-text-3">empty</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The flow itself, once the worker said this browser may add a source here. */
function SetupFlow({
  taken,
  suggested,
}: {
  readonly taken: readonly string[];
  readonly suggested: string;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const doneId = useId();
  // The admin connection string, for the length of the flow and nowhere else.
  const admin = useRef("");
  // One request per confirmation: a second click or a held Enter while one is in flight does nothing.
  const busy = useRef(false);
  // The connection's number: a reply that belongs to an earlier connection (one left with "Use
  // another connection string" while it was in flight) changes nothing on the page.
  const generation = useRef(0);
  const [typed, setTyped] = useState("");
  const [revealed, setRevealed] = useState(false);
  /** How the last install failed, when it did; held, the install waits until the person looked. */
  const [failure, setFailure] = useState<{
    readonly failed: InstallFailure;
    readonly source: string;
    readonly held: boolean;
  } | null>(null);
  /**
   * An install of this page that stopped or whose end is not known: from then on the page never
   * says nothing changed, and once the person read again it says what the file and the Sources list
   * hold. Kept for the life of the page, a new connection included.
   */
  const [started, setStarted] = useState<{
    readonly source: string;
    readonly table: string;
    readonly looked: { readonly fileNames: boolean; readonly listed: boolean } | null;
  } | null>(null);
  /** The preview is asking the model (a request in flight, as the others are). */
  const [previewing, setPreviewing] = useState(false);
  /** Why the last read-again after a started install failed; null when it did not. */
  const [lookFailure, setLookFailure] = useState<Error | null>(null);
  /** A preview has answered for the rows chosen now (step three is done). */
  const [previewed, setPreviewed] = useState(false);
  /** The furthest step the person moved into: the steps before it are behind them. */
  const [reached, setReached] = useState(1);
  const [connection, setConnection] = useState<Inspection | null>(null);
  const [choices, setChoices] = useState<SetupChoices | null>(null);
  /** The table last chosen in step two's list, whether or not it could be read. */
  const [picked, setPicked] = useState("");
  const [form, setForm] = useState<SourceForm>(() => firstForm(""));
  const [shownPlan, setShownPlan] = useState<{ key: string; plan: SetupPlan } | null>(null);
  const [force, setForce] = useState(false);
  const [installed, setInstalled] = useState<{
    readonly done: SetupInstalled;
    readonly plan: SetupPlan;
    /** The source's name as the draft that was installed named it. */
    readonly name: string;
  } | null>(null);

  // The latest choices for the preview's request, which is sent after the typing settles.
  const latest = useRef(choices);
  useEffect(() => {
    latest.current = choices;
  });

  const connect = useMutation({
    mutationFn: () => api.setupInspect(admin.current),
  });
  // The variables are the table's name: the admin string is read from the page, never kept here.
  const pick = useMutation({
    mutationFn: (table: string) => api.setupInspect(admin.current, table),
  });
  const plan = useMutation({
    mutationFn: (draft: SetupDraft) => api.setupPlan(admin.current, draft),
  });
  const install = useMutation({
    mutationFn: (sent: {
      readonly draft: SetupDraft;
      readonly token: string;
      readonly force: boolean;
    }) => api.setupInstall(admin.current, sent.draft, { token: sent.token, force: sent.force }),
  });
  // While an install runs, the studio's own navigation is held with a question (LeavePrompt), and
  // the browser's unload asks its standard question; at any other time neither is.
  const leaving = useBlocker({
    shouldBlockFn: () => install.isPending,
    enableBeforeUnload: () => install.isPending,
    withResolver: true,
  });
  /** A request of the flow's is in flight: its reply belongs to this connection. */
  const inFlight =
    connect.isPending || pick.isPending || plan.isPending || install.isPending || previewing;
  const previewOf = (draft: SourceDraft): Promise<DraftPreview> => {
    const now = latest.current;
    if (now === null) {
      return Promise.reject(new Error("Pick a table before the preview."));
    }
    return api.setupPreview(admin.current, { ...draft, ...sourcePart(now) });
  };

  const draft = choices === null ? undefined : setupDraftOf(choices, form, taken);
  const planOnScreen =
    shownPlan !== null && shownPlan.key === keyOf(draft) && draft !== undefined
      ? shownPlan.plan
      : null;

  /** Back to step one: everything the admin string reached is dropped with it. */
  function startOver() {
    generation.current += 1;
    busy.current = false;
    admin.current = "";
    connect.reset();
    pick.reset();
    plan.reset();
    install.reset();
    setConnection(null);
    setChoices(null);
    setPicked("");
    setShownPlan(null);
    setForce(false);
    setFailure(null);
    setPreviewed(false);
    setReached(1);
  }

  /**
   * One request at a time; `work` is told whether its connection is still the page's, so a late
   * reply of an earlier connection is dropped.
   */
  async function once(work: (current: () => boolean) => Promise<void>) {
    if (busy.current) {
      return;
    }
    busy.current = true;
    const mine = generation.current;
    try {
      await work(() => generation.current === mine);
    } catch {
      // The mutation holds the failure, which the step shows.
    } finally {
      if (generation.current === mine) {
        busy.current = false;
      }
    }
  }

  const onConnect = () =>
    once(async () => {
      const string = typed.trim();
      if (string === "") {
        return;
      }
      startOver();
      busy.current = true;
      const mine = generation.current;
      admin.current = string;
      try {
        const found = await connect.mutateAsync();
        if (generation.current !== mine) {
          return;
        }
        setConnection(found);
        // Step one is done: the string is not on screen, nor in the box's state, any more.
        setTyped("");
        setRevealed(false);
      } catch (error) {
        if (generation.current === mine) {
          admin.current = "";
          // Masked again after a failed connection: the person shows it again if they need to.
          setRevealed(false);
        }
        throw error;
      } finally {
        if (generation.current === mine) {
          busy.current = false;
        }
      }
    });

  const onPick = (table: string) =>
    once(async (current) => {
      setShownPlan(null);
      setPicked(table);
      // A table that cannot be read leaves no choices of the one before to install by mistake.
      setChoices(null);
      setPreviewed(false);
      const found = await pick.mutateAsync(table);
      const inspected = found.table;
      if (!current() || inspected === null) {
        return;
      }
      const name = nameFromTable(inspected.name);
      setChoices({
        table: inspected,
        name,
        read: firstRead(inspected),
        where: "",
        storage: "inline",
        // The variable of a source already reading this database, so one database stays one
        // string; else the file's first, or DATABASE_URL.
        variable: found.sharedWith?.variable ?? suggested,
        sharedWith: found.sharedWith,
      });
      setForm((before) => ({ ...before, name }));
    });

  const choose = (next: Partial<SetupChoices>) => {
    setChoices((before) => (before === null ? before : { ...before, ...next }));
    if (next.name !== undefined) {
      const name = next.name;
      setForm((before) => ({ ...before, name }));
    }
  };

  /** Reads the configuration and the sources again: what a failed install may have changed. */
  const readAgain = () => {
    void (async () => {
      await queryClient.invalidateQueries({ queryKey: ["sources"] });
      await queryClient.invalidateQueries({ queryKey: CONFIG_KEY });
      // Read even where no page shows them now: the Sources page opens on what the worker says.
      await queryClient.prefetchQuery(sourcesQuery(api));
    })();
  };

  const onPlan = () =>
    once(async (current) => {
      if (draft === undefined || failure?.held === true) {
        return;
      }
      install.reset();
      setFailure(null);
      setForce(false);
      const planned = await plan.mutateAsync(draft);
      if (current()) {
        setShownPlan({ key: keyOf(draft), plan: planned });
      }
    });

  // An install's reply is never dropped, whatever happened to the connection meanwhile: DDL may
  // have run, so its outcome is shown and the file and sources read again.
  const onInstall = () =>
    once(async () => {
      if (draft === undefined || planOnScreen === null || failure?.held === true) {
        return;
      }
      try {
        const done = await install.mutateAsync({ draft, token: planOnScreen.token, force });
        setInstalled({ done, plan: planOnScreen, name: draft.name });
        // Nothing is left to do with the admin string: it is forgotten now.
        admin.current = "";
        readAgain();
      } catch (error) {
        // A plan is spent by its attempt: the SQL is shown again before another one, and only
        // once the person has looked when the install may have started.
        setShownPlan(null);
        const failed = installFailure(error);
        setFailure({ failed, source: draft.name, held: failed.kind !== "nothing-ran" });
        if (failed.kind !== "nothing-ran") {
          setStarted({ source: draft.name, table: draft.table, looked: null });
          readAgain();
        }
        throw error;
      }
    });

  /**
   * After a stopped or an unknown install, the person says they looked: the file and the sources
   * are read again now, and the step says what they hold before anything else is offered.
   */
  const onLooked = () =>
    once(async () => {
      if (started === null) {
        return;
      }
      install.reset();
      setLookFailure(null);
      let config: Awaited<ReturnType<typeof api.projectConfig>>;
      let rows: Awaited<ReturnType<typeof api.sources>>;
      try {
        [config, rows] = await Promise.all([
          queryClient.fetchQuery({ ...projectConfigQuery(api), staleTime: 0 }),
          queryClient.fetchQuery({ ...sourcesQuery(api), staleTime: 0 }),
        ]);
      } catch (error) {
        // The install stays held; the person sees why the read did not happen, and tries again.
        setLookFailure(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      setStarted({
        ...started,
        looked: {
          fileNames: config.sources.some((source) => source.name === started.source),
          listed: rows.some((row) => row.name === started.source),
        },
      });
      setFailure(null);
    });

  const tableStep = choices === null ? undefined : tableProblem(choices);
  const nameStep = choices === null ? undefined : sourceNameProblem(choices.name, taken);
  const ready = choices !== null && tableStep === undefined && nameStep === undefined;
  const asked = ready && formHolds(form) && previewed;
  const steps = [
    connection !== null,
    ready,
    // The questions are written and the preview has answered them.
    asked,
    // The thresholds were set over that preview and the person went on past them.
    asked && reached >= 5,
    ready && variableProblem(choices.variable) === undefined && reached >= 6,
    installed !== null,
  ];
  const onReached = (number: number) => {
    setReached((before) => Math.max(before, number));
  };
  const current = steps.indexOf(false);
  const label = choices === null ? "" : choices.table.name;

  if (installed !== null) {
    const { done, name } = installed;
    const { worker } = done;
    return (
      <section aria-labelledby={doneId} className="grid max-w-[72ch] gap-4">
        <h2 id={doneId} className="text-[19px] font-bold tracking-tight">
          {`Installed on ${done.table}`}
        </h2>
        <p role="status">
          <StatusWord
            status="done"
            label={`The install ran, and ${name} is in ${done.path}.`}
            wrap
          />
        </p>
        {worker.running ? (
          // The last step: the worker's reload started the source, so the backfill of the records
          // already there is offered here, with its cost shown first.
          <>
            <p>{worker.words}</p>
            <p className="text-text-2">
              {`The records already in ${done.table} have no answer yet: answering them shows the estimate first, and nothing is asked until you press Start.`}
            </p>
            <BackfillControls source={name} />
          </>
        ) : (
          // Not started: the reload's own why, with what is missing and the command, then the restart.
          <>
            <p>{sentence(worker.why)}</p>
            <p>{worker.restart}</p>
            <p>{done.backfill}</p>
            <p className="text-text-2">{backfillWords(installed.plan)}</p>
          </>
        )}
        <div>
          <Link
            to="/sources"
            activeOptions={{ exact: true }}
            className={buttonClasses()}
            data-variant="primary"
            data-size="medium"
          >
            Back to Sources
          </Link>
        </div>
      </section>
    );
  }

  return (
    <>
      {leaving.status === "blocked" ? (
        <LeavePrompt
          source={draft?.name ?? choices?.name ?? "the source"}
          onStay={leaving.reset}
          onLeave={leaving.proceed}
        />
      ) : null}
      <ol className="m-0 grid list-none p-0">
        <Step number={1} title="Connect" current={current === 0} onReached={onReached}>
          {connection === null ? (
            <>
              <ConnectionField
                value={typed}
                revealed={revealed}
                onReveal={setRevealed}
                onChange={setTyped}
                onEnter={() => {
                  void onConnect();
                }}
                problem={connect.isError ? <Problem error={connect.error} /> : undefined}
              />
              <p className="max-w-[72ch] text-text-2">
                The connection string of a role that may alter the table. FacetDB recognises the
                database from it, creates a restricted login for its worker, and shows you the SQL
                before anything runs. This admin credential stays in this page until you leave it,
                is sent to the worker with each step, and is never kept. On FacetDB Cloud, Connect
                Supabase and Connect Neon do this step in one click.
              </p>
              <div>
                <Button
                  disabled={typed.trim() === "" || connect.isPending}
                  onClick={() => {
                    void onConnect();
                  }}
                >
                  {connect.isPending ? "Connecting" : "Connect"}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <StatusWord
                status="done"
                label={`Connected: ${connection.database}, ${countWords(connection.tables.length)} ${connection.tables.length === 1 ? "table" : "tables"}`}
              />
              <Button
                variant="quiet"
                size="small"
                // Never while a request is in flight: its reply belongs to this connection.
                disabled={inFlight}
                onClick={() => {
                  startOver();
                }}
              >
                Use another connection string
              </Button>
            </div>
          )}
        </Step>

        <Step
          number={2}
          title="Pick the table and the columns to read"
          current={current === 1}
          onReached={onReached}
        >
          {connection === null ? (
            <Waiting>After step one: the tables the connection may read are listed here.</Waiting>
          ) : (
            <TableStep
              connection={connection}
              choices={choices}
              picked={picked}
              picking={pick.isPending}
              failure={pick.isError ? pick.error : null}
              taken={taken}
              onPick={(table) => {
                void onPick(table);
              }}
              onChoose={choose}
            />
          )}
        </Step>

        {ready ? (
          <AskSteps
            // Other rows (another table, other columns, another filter) are another preview: it
            // starts again from the person's click, and no answer of the rows before stays on screen.
            key={JSON.stringify([choices.table.name, choices.read, choices.where.trim()])}
            source={choices.name}
            read={choices.read}
            form={form}
            onForm={setForm}
            blocked={draft === undefined}
            previewOf={previewOf}
            current={current}
            onReached={onReached}
            onPreviewed={setPreviewed}
            onPreviewing={setPreviewing}
          />
        ) : (
          <>
            <Step number={3} title="Write the questions" current={current === 2}>
              <Waiting>
                After step two: the questions are asked of the columns you check there.
              </Waiting>
            </Step>
            <Step number={4} title="Set the thresholds" current={current === 3}>
              <Waiting>
                After step three: each question's cut lines, counted over the preview's rows.
              </Waiting>
            </Step>
          </>
        )}

        <Step
          number={5}
          title="Choose storage, actions and alerts"
          current={current === 4}
          onReached={onReached}
        >
          {!ready ? (
            <Waiting>After step two.</Waiting>
          ) : (
            <KeepingStep choices={choices} label={label} onChoose={choose} />
          )}
        </Step>

        <Step number={6} title="Turn it on" current={current === 5} onReached={onReached}>
          {failure?.held === true ? (
            <InstallHeld
              failed={failure.failed}
              source={failure.source}
              readFailure={lookFailure}
              onLooked={() => {
                void onLooked();
              }}
            />
          ) : started?.looked?.fileNames === true &&
            (choices === null || choices.table.name === started.table) ? (
            <InFile
              source={started.source}
              table={started.table}
              looked={started.looked}
              readFailure={lookFailure}
              onLooked={() => {
                void onLooked();
              }}
            />
          ) : !ready || draft === undefined ? (
            <Waiting>
              {ready
                ? "Every question needs a name of its own and its cut lines in order, and the variable a name, before the SQL can be made."
                : "After the steps above: the install SQL is shown here before anything runs."}
            </Waiting>
          ) : (
            <div className="grid gap-4">
              {planOnScreen === null ? (
                <>
                  {started === null ? (
                    <p className="max-w-[72ch] text-text-2">
                      Nothing in your database or in facetdb.config.ts has changed yet. Show the SQL
                      to read what the install runs and what it writes into the file.
                    </p>
                  ) : (
                    <AfterStarted source={started.source} looked={started.looked} />
                  )}
                  {shownPlan !== null ? (
                    <p className="text-[13px] text-text-2">
                      The source changed since the SQL was shown: show it again to install this one.
                    </p>
                  ) : null}
                </>
              ) : (
                <PlanShown
                  plan={planOnScreen}
                  where={choices.where.trim()}
                  force={force}
                  onForce={setForce}
                />
              )}
              {plan.isError ? <Problem error={plan.error} /> : null}
              {failure === null ? null : <Problem error={failure.failed.error} />}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={plan.isPending || install.isPending}
                  onClick={() => {
                    void onPlan();
                  }}
                >
                  {planOnScreen === null ? "Show the SQL" : "Show the SQL again"}
                </Button>
                <Button
                  variant="primary"
                  disabled={
                    planOnScreen === null ||
                    install.isPending ||
                    plan.isPending ||
                    (planOnScreen.uncommitted !== null && !force)
                  }
                  onClick={() => {
                    void onInstall();
                  }}
                >
                  {install.isPending ? "Installing" : "Run the install"}
                </Button>
                {install.isPending ? (
                  // Nothing to cancel once the install is sent: the page waits for its reply.
                  <Button variant="quiet" disabled>
                    Cancel
                  </Button>
                ) : (
                  <Link
                    to="/sources"
                    activeOptions={{ exact: true }}
                    className={buttonClasses()}
                    data-variant="quiet"
                    data-size="medium"
                  >
                    Cancel
                  </Link>
                )}
              </div>
            </div>
          )}
        </Step>
      </ol>
    </>
  );
}

/**
 * Leaving the page by the studio's own navigation while an install runs: held until the person
 * chooses, in plain words; the reply would arrive at a page that is gone.
 */
function LeavePrompt({
  source,
  onStay,
  onLeave,
}: {
  readonly source: string;
  readonly onStay: () => void;
  readonly onLeave: () => void;
}) {
  const id = useId();
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    stay.current?.focus();
  }, []);
  return (
    <section
      role="alertdialog"
      aria-labelledby={id}
      className="mb-6 grid max-w-[72ch] gap-3 border-l-2 border-review pl-3"
    >
      <h2 id={id} className="text-[17px] font-bold">
        An install is running
      </h2>
      <p>
        {`The install of ${source} is running on your database. If you leave this page now, its outcome will not be shown: you would have to look at facetdb.config.ts, the Sources page and facetdb migrate --source ${source} --dry-run yourself.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button ref={stay} variant="primary" onClick={onStay}>
          Stay on this page
        </Button>
        <Button variant="quiet" onClick={onLeave}>
          Leave anyway
        </Button>
      </div>
    </section>
  );
}

/**
 * Steps three and four: the questions with the live preview of the chosen rows, then each
 * question's thresholds over the preview's answers. The preview follows the Questions page's rule
 * (questions/preview.ts): a first click, then 1.5 seconds after an edit of what the model reads;
 * never for a cut line or the stakes, never on a mount or a step change.
 */
function AskSteps({
  source,
  read,
  form,
  onForm,
  blocked,
  previewOf,
  current,
  onReached,
  onPreviewed,
  onPreviewing,
}: {
  readonly source: string;
  readonly read: readonly string[];
  readonly form: SourceForm;
  readonly onForm: (form: SourceForm) => void;
  /** The draft cannot be sent (a name or cut lines): nothing is asked until it can. */
  readonly blocked: boolean;
  readonly previewOf: (draft: SourceDraft) => Promise<DraftPreview>;
  /** The index of the first step not done, from 0. */
  readonly current: number;
  readonly onReached: (number: number) => void;
  /** Whether a preview of these rows is on screen: step three is done. */
  readonly onPreviewed: (previewed: boolean) => void;
  /** Whether a preview request is in flight. */
  readonly onPreviewing: (previewing: boolean) => void;
}) {
  // The person's edits of what the model reads: only they, or a click, ask the preview again.
  const [edits, setEdits] = useState(0);
  const preview = usePreview(form, edits, previewOf);
  const shown = preview.shown !== null;
  useEffect(() => {
    onPreviewed(shown);
  }, [shown, onPreviewed]);
  const running = preview.running;
  useEffect(() => {
    onPreviewing(running);
    // Unmounted (other rows chosen), its request is no longer the page's to wait for.
    return () => {
      onPreviewing(false);
    };
  }, [running, onPreviewing]);
  const edit = (next: SourceForm) => {
    if (previewKey(next) !== previewKey(form)) {
      setEdits((count) => count + 1);
    }
    onForm(next);
  };
  const replace = (index: number, next: SourceForm["questions"][number]) => {
    edit({
      ...form,
      questions: form.questions.map((existing, at) => (at === index ? next : existing)),
    });
  };
  return (
    <>
      <Step number={3} title="Write the questions" current={current === 2} onReached={onReached}>
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(300px,420px)_minmax(0,1fr)]">
          <div className="grid min-w-0 gap-6">
            {form.questions.map((question, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: a new question's name is what is being typed; its place is stable
                key={index}
                className={index === 0 ? "" : "border-t border-hairline pt-5.5"}
              >
                <QuestionEditor
                  question={question}
                  issues={[]}
                  nameProblem={nameProblem(form, index)}
                  fileOverride={{}}
                  previewed={preview.shown !== null}
                  figures={[]}
                  withThresholds={false}
                  onChange={(next) => {
                    replace(index, next);
                  }}
                  onRemove={
                    form.questions.length === 1
                      ? undefined
                      : () => {
                          edit({
                            ...form,
                            questions: form.questions.filter((_, at) => at !== index),
                          });
                        }
                  }
                />
              </div>
            ))}
            <div>
              <Button
                onClick={() => {
                  edit({ ...form, questions: [...form.questions, newQuestion(form)] });
                }}
              >
                Add a question
              </Button>
            </div>
          </div>
          <PreviewPanel
            source={source}
            read={read}
            form={form}
            preview={preview}
            blocked={blocked}
          />
        </div>
      </Step>

      <Step number={4} title="Set the thresholds" current={current === 3} onReached={onReached}>
        <div className="grid max-w-[640px] gap-6">
          <p className="text-text-2">
            Each question starts at its stakes' default. Move the cut lines and the counts follow,
            with no new model call.
          </p>
          {form.questions.map((question, index) => (
            <QuestionThresholds
              // biome-ignore lint/suspicious/noArrayIndexKey: as in step three, a question is its place
              key={index}
              question={question}
              heading={question.name}
              fileOverride={{}}
              previewed={preview.shown !== null}
              figures={
                preview.shown === null
                  ? []
                  : figuresFor(question, preview.shown.form, preview.shown.result.rows)
              }
              problem={undefined}
              onChange={(next) => {
                replace(index, next);
              }}
            />
          ))}
        </div>
      </Step>
    </>
  );
}

/**
 * Step six after an install that may have changed something (review blocks B and C): the worker's
 * words, or plain words when no answer came, where to look, and no second install until the person
 * says they looked. The configuration and the sources were read again when it failed.
 */
function InstallHeld({
  failed,
  source,
  readFailure,
  onLooked,
}: {
  readonly failed: InstallFailure;
  readonly source: string;
  /** Why the last read-again failed; null when it did not. */
  readonly readFailure: Error | null;
  readonly onLooked: () => void;
}) {
  const id = useId();
  const answered = failed.error instanceof ApiError && failed.error.code !== "unreadable";
  return (
    <section aria-labelledby={id} className="grid max-w-[72ch] gap-3">
      <h3 id={id} className="text-[15px] font-bold">
        {failed.kind === "stopped" ? "The install stopped" : "How the install ended is not known"}
      </h3>
      {failed.kind === "unknown" && !answered ? (
        <p role="alert" className="grid gap-1 border-l-2 border-no pl-3">
          <span>
            {`The install of ${source} was sent, and no answer came back from the worker, so whether it ran is not known: the file may name ${source}, and the database may hold its install.`}
          </span>
        </p>
      ) : (
        <Problem error={failed.error} />
      )}
      {failed.kind === "unknown" ? (
        <>
          <p>Look before anything else:</p>
          <ul className="m-0 grid gap-1 pl-5">
            <li>
              {"the "}
              <Link
                to="/sources"
                activeOptions={{ exact: true }}
                className="font-semibold text-facet-text underline underline-offset-4"
              >
                Sources page
              </Link>
              {`, which lists ${source} once a worker started after the install runs it;`}
            </li>
            <li>
              <code className="font-mono text-[13px]">{`facetdb migrate --source ${source} --dry-run`}</code>
              {
                " on the machine that runs the worker, which prints nothing to run once the install is there;"
              }
            </li>
            <li>{`facetdb.config.ts itself, which names ${source} if it was written.`}</li>
          </ul>
        </>
      ) : (
        <p>
          The configuration and the sources were read again. Run the command above on the machine
          that runs the worker; the install stays off here until you have.
        </p>
      )}
      <ReadAgain
        label={
          failed.kind === "stopped" ? "I have run it: read again" : "I have looked: read again"
        }
        readFailure={readFailure}
        onLooked={onLooked}
      />
    </section>
  );
}

/**
 * The read-again of the file and the Sources list, and why the last one failed, under the button
 * with Try again in its place.
 */
function ReadAgain({
  label,
  readFailure,
  onLooked,
}: {
  readonly label: string;
  readonly readFailure: Error | null;
  readonly onLooked: () => void;
}) {
  return (
    <div className="grid justify-items-start gap-2">
      <Button variant="secondary" onClick={onLooked}>
        {readFailure === null ? label : "Try again"}
      </Button>
      {readFailure === null ? null : (
        <div className="grid gap-1">
          <p className="text-[13px] text-text-2">
            The file and the sources could not be read again, so nothing above has changed:
          </p>
          <Problem error={readFailure} />
        </div>
      )}
    </div>
  );
}

/** What the file and the Sources list held when the person read them again. */
function lookedWords(
  source: string,
  looked: { readonly fileNames: boolean; readonly listed: boolean },
): string {
  const file = looked.fileNames
    ? `facetdb.config.ts names ${source}`
    : `facetdb.config.ts does not name ${source}`;
  const list = looked.listed
    ? `the Sources page lists ${source}`
    : `the Sources page does not list ${source} (a worker started after an install lists it)`;
  return `Read again just now: ${file}, and ${list}.`;
}

/**
 * Step six once an install of this page stopped or ended unknown, and the file does not name the
 * source: never "nothing has changed", which this page can no longer know.
 */
function AfterStarted({
  source,
  looked,
}: {
  readonly source: string;
  readonly looked: { readonly fileNames: boolean; readonly listed: boolean } | null;
}) {
  return (
    <div className="grid max-w-[72ch] gap-2">
      <p className="text-text-2">
        An earlier install from this page started. The SQL is planned afresh from what the database
        holds now: show it to read what is still to run and what the file gets.
      </p>
      {looked === null ? null : <p className="text-text-2">{lookedWords(source, looked)}</p>}
    </div>
  );
}

/**
 * Step six once the file names the source an earlier install of this page started: it is not
 * installed again from here, under that name or another, on the same table.
 */
function InFile({
  source,
  table,
  looked,
  readFailure,
  onLooked,
}: {
  readonly source: string;
  readonly table: string;
  readonly looked: { readonly fileNames: boolean; readonly listed: boolean };
  /** Why the last read-again failed; null when it did not. */
  readonly readFailure: Error | null;
  readonly onLooked: () => void;
}) {
  return (
    <div className="grid max-w-[72ch] gap-3">
      <p className="text-text-2">{lookedWords(source, looked)}</p>
      <p>
        {`${source} is in facetdb.config.ts, so ${table} is not installed again from here, under that name or another. Finish or check its install on the machine that runs the worker: `}
        <code className="font-mono text-[13px]">{`facetdb migrate --source ${source}`}</code>
        {
          " prints what is still to run (nothing once the install is there) and asks before it runs; then restart facetdb worker. To take it out instead, "
        }
        <code className="font-mono text-[13px]">{`facetdb uninstall --source ${source}`}</code>
        {" and remove it from facetdb.config.ts, then read again here."}
      </p>
      <ReadAgain label="Read again" readFailure={readFailure} onLooked={onLooked} />
      <div>
        <Link
          to="/sources"
          activeOptions={{ exact: true }}
          className={buttonClasses()}
          data-variant="secondary"
          data-size="medium"
        >
          Sources page
        </Link>
      </div>
    </div>
  );
}

/** The backfill's estimate in words, from the plan. */
function backfillWords(plan: SetupPlan): string {
  const { backfill } = plan;
  const records =
    backfill.counted === "statistics"
      ? `about ${countWords(backfill.records)} records (the database's own estimate of the table's size; nothing was counted)`
      : `at least ${countWords(backfill.records)} records (the rows read here: the database has no estimate of the table's size yet)`;
  // A source not yet installed has no answer billed to scale the estimate by, so its figures are
  // the characters' count alone, a floor, and said so.
  const cost =
    backfill.inputTokens > 0
      ? `at least ${floorDollarWords(backfill.dollars)} (at least ${countWords(backfill.inputTokens)} input tokens)`
      : `${dollarWords(backfill.dollars)} (${countWords(backfill.inputTokens)} input tokens)`;
  return `The backfill of the rows already there: ${records}, newest first, at most ${countWords(backfill.pace)} a second, ${durationWords(backfill.seconds)} and ${cost}. Start it with ${backfill.command} once the worker runs the source: it counts exactly and shows its estimate first.`;
}

/** Step two once connected: the table, its columns and rows, the source's name and its filter. */
function TableStep({
  connection,
  choices,
  picked,
  picking,
  failure,
  taken,
  onPick,
  onChoose,
}: {
  readonly connection: Inspection;
  readonly choices: SetupChoices | null;
  /** The table chosen in the list ("" for none yet): the list shows it, read or refused. */
  readonly picked: string;
  readonly picking: boolean;
  readonly failure: Error | null;
  readonly taken: readonly string[];
  readonly onPick: (table: string) => void;
  readonly onChoose: (next: Partial<SetupChoices>) => void;
}) {
  const tableId = useId();
  const problem = choices === null ? undefined : tableProblem(choices);
  // A connection that may read no table has nothing to choose: the list is shut and says so, rather
  // than opening on nothing ("clicking choose table doesn't do anything").
  const none = connection.tables.length === 0;
  // The chosen table's size as the database estimates it; nothing when it has no estimate.
  const estimate = picking || failure !== null ? null : (choices?.table.estimatedRows ?? null);
  const size = estimate === null ? undefined : aboutRows(estimate);
  return (
    <div className="grid gap-5">
      <div className="grid max-w-[420px] gap-1.5">
        <label htmlFor={tableId} className="text-[13px] text-text-2">
          Table
        </label>
        <Listbox
          id={tableId}
          label="Table"
          width="full"
          placeholder={none ? "No table to choose" : "Choose a table"}
          options={connection.tables.map((table) => ({ value: table, label: table }))}
          value={picked}
          disabled={picking || none}
          onValueChange={onPick}
        />
        {size === undefined ? null : <p className="text-[13px] text-text-2">{size}</p>}
        {none ? (
          <div role="status" className="grid gap-1">
            <StatusWord status="warning" size="small" label="This connection can read no table" />
            <p className="text-[13px] text-text-2">
              The connection works, but its role may not read a whole table in that database, so
              there is nothing to choose. The worker's own login (the one in DATABASE_URL) is such a
              role: it reads only the columns it was granted. Use another connection string above:
              the admin one you would give facetdb migrate, for the database that holds your table.
            </p>
          </div>
        ) : null}
      </div>
      {picking ? (
        <p role="status" className="text-[13px] text-text-2">
          Reading the table's columns and five of its rows
        </p>
      ) : null}
      {failure === null ? null : <Problem error={failure} />}
      {choices === null || failure !== null ? null : (
        <>
          <fieldset className="m-0 grid gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-[13px] text-text-2">
              Columns the model reads. Only these are sent; everything else stays in your database.
            </legend>
            {choices.table.key === null ? null : (
              <p className="font-mono text-[13px]">
                {choices.table.key}
                <span className="ml-2 font-sans text-text-3">
                  the key: each answer is kept by it
                </span>
              </p>
            )}
            {choices.table.columns
              .filter((column) => column.name !== choices.table.key)
              .map((column) => (
                <Check
                  key={column.name}
                  label={column.name}
                  hint={column.type}
                  checked={choices.read.includes(column.name)}
                  onChange={(checked) => {
                    onChoose({
                      read: checked
                        ? choices.table.columns
                            .map((each) => each.name)
                            .filter((name) => name === column.name || choices.read.includes(name))
                        : choices.read.filter((name) => name !== column.name),
                    });
                  }}
                />
              ))}
          </fieldset>
          {problem === undefined ? null : (
            <p role="alert" className="max-w-[72ch] border-l-2 border-no pl-3">
              {problem}
            </p>
          )}
          <SampleRows table={choices.table} read={choices.read} />
          <div className="grid max-w-[420px] gap-4">
            <TextField
              label="The source's name in facetdb.config.ts"
              value={choices.name}
              problem={sourceNameProblem(choices.name, taken)}
              onChange={(name) => {
                onChoose({ name });
              }}
            />
          </div>
          <div className="grid max-w-[640px] gap-1.5">
            <TextField
              label="Only rows where (optional)"
              rows={2}
              placeholder="status = 'published'"
              value={choices.where}
              onChange={(where) => {
                onChoose({ where });
              }}
            />
            <p className="text-[13px] text-text-2">
              This is SQL the worker runs in your database as you type it, in its queries and in the
              install's trigger. Leave it empty to answer every row.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/** Step five: where the answers go, the worker's connection, actions and alerts. */
function KeepingStep({
  choices,
  label,
  onChoose,
}: {
  readonly choices: SetupChoices;
  readonly label: string;
  readonly onChoose: (next: Partial<SetupChoices>) => void;
}) {
  const storageId = useId();
  const words = STORAGE_WORDS(label);
  return (
    <div className="grid max-w-[640px] gap-5">
      <div className="grid gap-1.5">
        <label htmlFor={storageId} className="text-[13px] text-text-2">
          Where the answers go
        </label>
        <Listbox
          id={storageId}
          label="Where the answers go"
          width="full"
          options={(["inline", "side-table"] as const).map((storage) => ({
            value: storage,
            label: words[storage],
          }))}
          value={choices.storage}
          onValueChange={(value) => {
            onChoose({ storage: value === "side-table" ? "side-table" : "inline" });
          }}
        />
        <p className="text-[13px] text-text-2">
          A side table keeps FacetDB's columns out of your table, so a schema rebuild by an ORM
          never touches them.
        </p>
      </div>
      <div className="grid gap-1.5">
        <TextField
          label="The variable that holds the worker's connection string"
          value={choices.variable}
          problem={variableProblem(choices.variable)}
          onChange={(variable) => {
            onChoose({ variable: variable.trim() });
          }}
        />
        <p className="text-[13px] text-text-2">
          facetdb.config.ts names this variable, never a connection string. Where the worker runs it
          holds postgres://facetdb_worker:&lt;a long random
          password&gt;@&lt;host&gt;/&lt;database&gt;: the install creates that login with that
          password. The SQL step says whether it is set, and never shows its value.
        </p>
        {choices.sharedWith === null ? null : (
          <p className="text-[13px] text-text-2">
            {`${choices.sharedWith.source} already reads this database through ${choices.sharedWith.variable}, so the same variable is suggested: two variables holding one string would leave Apply unable to tell which source reads which.`}
          </p>
        )}
      </div>
      <div className="grid gap-1">
        <p className="text-[13px] text-text-2">After a decision</p>
        <p>
          The answer is written to its columns, nothing else. Webhooks and plugin actions are added
          in facetdb.config.ts.
        </p>
      </div>
      <div className="grid gap-1">
        <p className="text-[13px] text-text-2">Who is told when something breaks</p>
        <p>
          The project's alert channels, as the{" "}
          <Link to="/alerts" className="font-semibold text-facet-text underline underline-offset-4">
            Alerts page
          </Link>{" "}
          lists them.
        </p>
      </div>
    </div>
  );
}

/**
 * A script or a diff as text in a `pre` block, in a region that scrolls: named by the line above
 * it, and reached by Tab so its arrows scroll it, with the corner brackets on focus.
 */
function Scroll({
  labelledBy,
  tall,
  children,
}: {
  readonly labelledBy: string;
  readonly tall: boolean;
  readonly children: string;
}) {
  return (
    <ScrollRegion
      aria-labelledby={labelledBy}
      className={`${tall ? "max-h-[420px]" : "max-h-[320px]"} border border-hairline`}
    >
      <pre className="m-0 p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre">
        {children}
      </pre>
    </ScrollRegion>
  );
}

/** Step six's plan: the SQL as facetdb migrate prints it, the file's diff, and what follows. */
function PlanShown({
  plan,
  where,
  force,
  onForce,
}: {
  readonly plan: SetupPlan;
  readonly where: string;
  readonly force: boolean;
  readonly onForce: (force: boolean) => void;
}) {
  const sqlId = useId();
  const diffId = useId();
  return (
    <div className="grid gap-4">
      <p id={sqlId} className="max-w-[72ch] text-text-2">
        {`This runs once on ${plan.table} with the admin connection string from step one${plan.transactional ? ", as one transaction: all of it or nothing" : ""}. Read it first: it is the text facetdb migrate --dry-run prints for this source, below the FacetDB store's part.`}
      </p>
      <Scroll labelledBy={sqlId} tall>
        {plan.sql}
      </Scroll>
      {where === "" ? null : (
        <p className="max-w-[72ch] border-l-2 border-review pl-3">
          {`The where filter is SQL the worker runs as you typed it: ${where}. It is in the script above and in the file below. It can call a function: while you set up, it ran as the admin role only inside a read-only transaction with a 5-second limit; once installed it runs as written in the worker's queries and the trigger.`}
        </p>
      )}
      <p id={diffId} className="text-text-2">
        {`Then ${plan.path} gets the source:`}
      </p>
      <Scroll labelledBy={diffId} tall={false}>
        {plan.diff}
      </Scroll>
      <dl className="m-0 grid max-w-[72ch] grid-cols-[88px_minmax(0,1fr)] gap-x-4 gap-y-2.5">
        <dt className="text-[13px] text-text-2">Then</dt>
        <dd className="m-0">
          The worker that is running reads facetdb.config.ts again, checks the install under its own
          login and starts the source, with no restart. If it cannot (its database could not be
          read, or the install is not where the worker reads, say), this page says why and what to
          run.
        </dd>
        <dt className="text-[13px] text-text-2">Backfill</dt>
        <dd className="m-0">{backfillWords(plan)}</dd>
      </dl>
      {plan.warnings.length === 0 ? null : (
        <ul className="m-0 grid max-w-[72ch] list-none gap-2 p-0">
          {plan.warnings.map((warning) => (
            <li
              key={`${warning.question ?? ""}:${warning.code}`}
              className="grid gap-1 border-l-2 border-review pl-3"
            >
              <span>{warning.message}</span>
              <span className="text-text-2">{warning.fix}</span>
            </li>
          ))}
        </ul>
      )}
      {plan.uncommitted === null ? null : (
        <ReplaceAnyway state={plan.uncommitted.state} checked={force} onChange={onForce} />
      )}
    </div>
  );
}

export function AddSourcePage() {
  const api = useApi();
  const access = useQuery({
    queryKey: ["sources", "setup"],
    queryFn: () => api.setupAccess(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const config = useQuery(projectConfigQuery(api));
  const head = (
    <PageHead
      title="Add a source"
      lede="Six steps. Nothing in your database changes until the last one, and you see the SQL first."
    />
  );
  if (access.data === undefined || config.data === undefined) {
    const failure = access.error ?? config.error;
    return (
      <>
        {head}
        {failure === null ? (
          <p role="status" className="text-text-2">
            Asking the worker whether a source can be added here
          </p>
        ) : (
          <Problem error={failure} />
        )}
      </>
    );
  }
  if (!access.data.open) {
    return (
      <>
        {head}
        <div className="grid max-w-[72ch] gap-3">
          <Problem
            error={new ApiError(403, access.data.code, access.data.message, access.data.fix)}
          />
          <div>
            <Link
              to="/sources"
              activeOptions={{ exact: true }}
              className={buttonClasses()}
              data-variant="secondary"
              data-size="medium"
            >
              Back to Sources
            </Link>
          </div>
        </div>
      </>
    );
  }
  const sources = config.data.sources;
  return (
    <>
      {head}
      <SetupFlow
        taken={sources.map((source) => source.name)}
        suggested={
          sources.find((source) => source.database !== undefined)?.database?.env ?? "DATABASE_URL"
        }
      />
    </>
  );
}
