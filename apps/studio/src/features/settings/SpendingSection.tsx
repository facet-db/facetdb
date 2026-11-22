import { Button, DitherStrip, focusBrackets } from "@facetdb/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  homeQuery,
  type SpendingConfig,
  type SpendingDraft,
  spendingConfigQuery,
} from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import {
  compactTokens,
  fileDiffersFromWorker,
  fileSetsWords,
  groupedTokens,
} from "../../shell/index.ts";
import { Reloaded } from "../questions/index.ts";
import { Field, type FieldProblem } from "./Field.tsx";
import { SpendingApplyDialog } from "./SpendingApplyDialog.tsx";
import { Unreachable } from "./Unreachable.tsx";
import { AT_CAP_WORDS, capFromText, capText, money } from "./words.ts";

/**
 * The spending cap: the cap the worker enforces, what happens at 100% and the month's spending,
 * from `GET /v1/home` (the page computes no figure), and a form that changes the cap in
 * facetdb.config.ts.
 *
 * The form starts from the file as `GET /v1/config` reads it now. Save checks the number, then
 * opens the diff the project draft makes to the file (`POST /v1/apply` with `project`), and the
 * write is the second step with the plan that diff named, as the Questions page's Apply. The worker
 * takes the written cap up in that write's reload, so the figures above show it as soon as they are
 * read again. Only a file edited by hand since the last reload sets a cap the worker has not taken
 * up: the note under the figures says so, with a button that asks the worker to reload the file
 * (`POST /v1/reload`, as Check again does).
 */

const STRIP_WIDTH = 200;

function Line({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-1 min-[600px]:grid-cols-[130px_minmax(0,1fr)]">
      <dt className="text-text-2">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}

/** A native radio or checkbox in the brief's skin: the accent, and the brackets on keyboard focus. */
function Choice({
  type,
  name,
  checked,
  onChange,
  children,
}: {
  readonly type: "radio" | "checkbox";
  readonly name?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <span
      className={`${focusBrackets} relative inline-flex w-fit items-baseline has-[:focus-visible]:after:opacity-100!`}
    >
      <input
        id={id}
        type={type}
        {...(name === undefined ? {} : { name })}
        className="accent-facet focus-visible:outline-2 focus-visible:outline-transparent"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <label htmlFor={id} className="pl-2">
        {children}
      </label>
    </span>
  );
}

/**
 * The form over the file's cap; keyed by what the file says, so a write read back starts it anew.
 * The dialog Save opens lives beside it, not in it, so that new start leaves the dialog open.
 */
function CapForm({
  file,
  onSave,
  saveRef,
}: {
  readonly file: SpendingConfig;
  readonly onSave: (draft: SpendingDraft) => void;
  /** Save, which takes the focus back when the dialog it opened closes. */
  readonly saveRef: Ref<HTMLButtonElement>;
}) {
  const atCapName = useId();
  const [noCap, setNoCap] = useState(file.tokens === null);
  const [text, setText] = useState(file.tokens === null ? "" : capText(file.tokens));
  const [onCapReached, setOnCapReached] = useState(file.onCapReached);
  const [problem, setProblem] = useState<FieldProblem | undefined>(undefined);

  const save = (event: FormEvent) => {
    event.preventDefault();
    let spendingCap: number | null = null;
    if (!noCap) {
      const cap = capFromText(text);
      if (!cap.ok) {
        setProblem(cap.problem);
        return;
      }
      spendingCap = cap.tokens;
    }
    setProblem(undefined);
    onSave({ spendingCap, onCapReached });
  };

  return (
    <form noValidate onSubmit={save} className="grid gap-4">
      <div className="grid gap-4 min-[600px]:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
        <div className="grid content-start gap-2">
          <Field
            label="Monthly cap, in billable input tokens"
            inputMode="numeric"
            autoComplete="off"
            value={noCap ? "" : text}
            disabled={noCap}
            problem={problem}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
          <Choice
            type="checkbox"
            checked={noCap}
            onChange={(checked) => {
              setNoCap(checked);
              setProblem(undefined);
            }}
          >
            No monthly cap
          </Choice>
        </div>
        <fieldset className="m-0 grid min-w-0 content-start gap-2 border-0 p-0">
          <legend className="mb-1.5 p-0 text-[13px] text-text-2">At 100%</legend>
          {(["pause", "continue"] as const).map((choice) => (
            <Choice
              key={choice}
              type="radio"
              name={atCapName}
              checked={onCapReached === choice}
              onChange={(checked) => {
                if (checked) {
                  setOnCapReached(choice);
                }
              }}
            >
              {AT_CAP_WORDS[choice]}
            </Choice>
          ))}
        </fieldset>
      </div>
      <div>
        <Button ref={saveRef} type="submit">
          Save
        </Button>
      </div>
    </form>
  );
}

/**
 * The file sets a cap the worker has not taken up (edited by hand since the last reload, or that
 * reload did not load): the words, and the reload that applies it, in the reload's own outcome.
 */
function FileCapAhead({ sets }: { readonly sets: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const reload = useMutation({
    mutationFn: () => api.reload(),
    onSuccess: () => {
      // The cap in force and the file are read again: when the reload loaded, they now agree.
      void queryClient.invalidateQueries({ queryKey: ["home"] });
      void queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });
  const outcome = reload.data;
  return (
    <div className="grid max-w-[64ch] gap-3 border-l-2 border-facet pl-3">
      <p role="status" className="m-0">
        {`facetdb.config.ts sets ${sets}; the worker still enforces the cap above. Applying reloads the whole file, as Check again does.`}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button size="small" onClick={() => reload.mutate()} disabled={reload.isPending}>
          {reload.isPending ? "Applying" : "Apply the file's cap"}
        </Button>
        {outcome === undefined ? null : outcome.loaded ? (
          <span role="status" className="text-text-2">
            Applied: the worker enforces the file's cap now.
          </span>
        ) : null}
        {reload.isError ? (
          <span role="alert" className="text-text-2">
            {reload.error instanceof ApiError
              ? `${reload.error.message} ${reload.error.fix}`
              : "The worker could not be reached, so the cap above stands."}
          </span>
        ) : null}
      </div>
      {/* The reload is Check again's: a file edited by hand may hold more than the cap, so every source's outcome is shown. */}
      {outcome === undefined ? null : <Reloaded reload={outcome} />}
    </div>
  );
}

export function SpendingSection() {
  const api = useApi();
  const schedule = useSchedule();
  const file = useQuery(spendingConfigQuery(api));
  const home = useQuery(homeQuery(api));
  const headingId = useId();
  /** The draft the open dialog shows; null while it is closed. */
  const [draft, setDraft] = useState<SpendingDraft | null>(null);
  const [opened, setOpened] = useState(0);
  // The dialog has no trigger of its own, so Radix gives the focus back to nothing when it closes:
  // once it is gone, Save takes it back (the form's new Save, when the write started it anew).
  const save = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  useEffect(() => {
    if (draft === null && closing.current) {
      closing.current = false;
      save.current?.focus();
    }
  }, [draft]);
  const now = new Date(schedule.now());
  const spending = home.data?.spending;
  const inForce = spending?.cap;
  // What the file sets, in words, when that is not what the worker enforces.
  const fileSets =
    inForce !== undefined && file.data !== undefined && fileDiffersFromWorker(inForce, file.data)
      ? fileSetsWords(file.data)
      : null;
  const failed = home.isError ? home : file.isError ? file : undefined;
  return (
    <section aria-labelledby={headingId} className="grid gap-4">
      <h2 id={headingId} className="text-lg font-bold tracking-tight">
        Spending cap
      </h2>
      {failed === undefined ? null : (
        <Unreachable
          what={failed === file ? "The cap in facetdb.config.ts" : "The spending cap"}
          error={failed.error}
          lastKnownAt={failed.data === undefined ? undefined : failed.dataUpdatedAt}
          now={now}
          retry={() => {
            void failed.refetch();
          }}
        />
      )}
      {spending === undefined ? (
        home.isError ? null : (
          <p role="status" className="text-text-2">
            Reading the cap.
          </p>
        )
      ) : (
        // Named apart from the form below, which offers the same choices for the file.
        <section aria-label="The cap the worker enforces">
          <dl className="m-0 grid gap-3">
            <Line label="Monthly cap">
              {spending.cap === null ? (
                "None set, so the project never pauses."
              ) : (
                <>
                  <span className="font-mono font-semibold">
                    {compactTokens(spending.cap.inputTokens)}
                  </span>
                  {` billable input tokens (${groupedTokens(spending.cap.inputTokens)}), ${money(spending.cap.dollars)} at the model's price`}
                </>
              )}
            </Line>
            {spending.cap === null ? null : (
              <Line label="At 100%">{AT_CAP_WORDS[spending.cap.onCapReached]}</Line>
            )}
            <Line label="This month">
              <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="font-mono font-semibold">{spending.words.figure}</span>
                {spending.fraction === null ? null : (
                  <DitherStrip
                    value={spending.fraction}
                    width={STRIP_WIDTH}
                    rows={4}
                    label={spending.words.sub}
                  />
                )}
                <span
                  className="text-text-2"
                  aria-hidden={spending.fraction === null ? undefined : true}
                >
                  {spending.words.sub}
                </span>
              </span>
            </Line>
          </dl>
        </section>
      )}
      {fileSets === null ? null : <FileCapAhead sets={fileSets} />}
      <p className="max-w-[64ch] text-text-2">
        Save shows the change to <code>facetdb.config.ts</code> before anything is written; Apply
        writes it, and the worker enforces the new cap at once. A warning goes out at 80% of the
        cap.
      </p>
      {file.data === undefined ? null : (
        <CapForm
          key={`${String(file.data.tokens)} ${file.data.onCapReached}`}
          file={file.data}
          saveRef={save}
          onSave={(saved) => {
            setDraft(saved);
            setOpened((count) => count + 1);
          }}
        />
      )}
      {draft === null ? null : (
        <SpendingApplyDialog
          draft={draft}
          open
          opened={opened}
          onOpenChange={(open) => {
            if (!open) {
              closing.current = true;
              setDraft(null);
            }
          }}
        />
      )}
    </section>
  );
}
