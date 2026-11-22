import { Button, Dialog, DialogClose, DitherGradient, focusBrackets, Tag } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useId, useState } from "react";
import { ApiError, type ConfigSource, type QuestionPack } from "../../api/index.ts";
import { useApi } from "../../deps.tsx";
import { type QuestionForm, type SourceForm, thresholdsOf } from "./draft.ts";
import { CommandLine } from "./NotRunning.tsx";
import {
  fieldsOf,
  firstSentence,
  type Kept,
  type PackQuestion,
  packQuestions,
  withPack,
} from "./pack.ts";
import { packsQuery } from "./queries.ts";
import { plural, TYPE_WORDS } from "./words.ts";

/**
 * "Start from a pack": beside "Add a question", a dialog with the packs of the installed plugins as
 * radio rows, none chosen. Choosing one shows its questions (kind, wording, thresholds, new or
 * already in the draft) and the fields it reads beside the source's, with a warning that does not
 * block for a field the source lacks; nothing changes until the confirm, which fills the draft
 * only. Nothing is written before Apply's own diff and confirm.
 */

/** The first-party plugins that bring a pack, for a project that has none installed. */
const PACK_PLUGINS = [
  { pack: "marketplace", words: "Trust and safety for listings", command: "facetdb add packs" },
  { pack: "triage", words: "GitHub issue triage", command: "facetdb add github" },
] as const;

const percent = (figure: number): string => `${String(Math.round(figure * 100))}%`;

/** Two plugins may each ship a pack of one name: the package tells them apart. */
const keyOf = (pack: QuestionPack): string => `${pack.package} ${pack.name}`;

/** A pack's name in the list, with its plugin's only when another pack has the same name. */
function labelOf(pack: QuestionPack, list: readonly QuestionPack[]): string {
  const shared = list.some((other) => other !== pack && other.name === pack.name);
  return shared ? `${pack.name} (${pack.plugin})` : pack.name;
}

/** Text with field names in backticks, as packs write them: each name set as code. */
function Ticked({ text }: { readonly text: string }) {
  const parts = text.split("`");
  // An odd number of backticks pairs nothing reliably: the text as written.
  if (parts.length % 2 === 0) {
    return <>{text}</>;
  }
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text, in order
          <code key={index} className="font-mono text-[12.5px]">
            {part}
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text, in order
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** Field names as code: "`a`, `b`" in a list, "`a`, `b` or `c`" in a sentence. */
function Fields({
  names,
  last = ", ",
}: {
  readonly names: readonly string[];
  readonly last?: ", " | " or " | " and ";
}) {
  return (
    <>
      {names.map((name, index) => (
        <Fragment key={name}>
          {index === 0 ? "" : index === names.length - 1 ? last : ", "}
          <code className="font-mono text-[12.5px]">{name}</code>
        </Fragment>
      ))}
    </>
  );
}

/** A question's thresholds as the list shows them: the cut lines on a strip, the words beside it. */
function CutStrip({ question }: { readonly question: QuestionForm }) {
  const thresholds = thresholdsOf(question);
  const cuts =
    thresholds.kind === "cuts"
      ? [thresholds.noBelow, thresholds.yesAbove]
      : [thresholds.confidenceAtLeast];
  const words =
    thresholds.kind === "cuts"
      ? `No at or below ${percent(thresholds.noBelow)}, yes at or above ${percent(thresholds.yesAbove)}`
      : `Decides its top ${question.type === "score" ? "level" : "option"} when ${percent(thresholds.confidenceAtLeast)} confident or more`;
  return (
    <span className="inline-flex min-w-0 items-center gap-2.5 text-[12.5px]">
      {/* The words carry the figures: the strip is their picture. */}
      <span aria-hidden="true" className="relative inline-block flex-none leading-none">
        <DitherGradient width={96} rows={4} />
        {cuts.map((cut) => (
          <span
            key={cut}
            className="absolute -top-0.75 -bottom-0.75 w-0.5 -translate-x-px bg-text"
            style={{ left: `${String(cut * 100)}%` }}
          />
        ))}
      </span>
      <span>{words}</span>
    </span>
  );
}

/** A pack question whose name is taken stays out: where the name already is. */
const KEPT_WORDS: Readonly<Record<Kept, string>> = {
  draft: "Already in the draft",
  file: "Already in the file",
};

const ROW = "flex flex-wrap items-baseline justify-between gap-4 border-t border-hairline py-2.5";
const FIRST_ROW = "first:border-t-0 first:pt-0";

function PackQuestions({ questions }: { readonly questions: readonly PackQuestion[] }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-2">
      <h3 id={id} className="m-0 text-[15px] font-semibold">
        Questions
      </h3>
      <ul className="m-0 grid list-none p-0">
        {questions.map(({ question, kept }) => (
          <li key={question.name} className={`${ROW} ${FIRST_ROW}`}>
            <span className="grid min-w-0 flex-[1_1_260px] gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <strong className="font-mono text-[12.5px] font-semibold">{question.name}</strong>
                <Tag>{`${TYPE_WORDS[question.type]}, ${question.stakes} stakes`}</Tag>
                {/* A column the editor has no control for: said here, before it reaches the file. */}
                {question.type === "choice" && question.storeProbabilities ? (
                  <Tag>Stores probabilities</Tag>
                ) : null}
              </span>
              <span className="text-[12.5px] text-text-2">
                <Ticked text={question.instructions} />
              </span>
              <CutStrip question={question} />
            </span>
            <span className={kept === null ? "text-[12.5px]" : "text-[12.5px] text-text-2"}>
              {kept === null ? "New" : KEPT_WORDS[kept]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What the pack reads beside what the source reads; a field the source lacks is said, not refused. */
function PackFields({
  pack,
  source,
  warningId,
}: {
  readonly pack: QuestionPack;
  readonly source: ConfigSource;
  readonly warningId: string;
}) {
  const id = useId();
  const fields = fieldsOf(pack, source.read);
  if (pack.reads === null || fields === undefined) {
    return null;
  }
  return (
    <section aria-labelledby={id} className="grid gap-2">
      <h3 id={id} className="m-0 text-[15px] font-semibold">
        Fields
      </h3>
      <dl className="m-0 grid grid-cols-[minmax(110px,max-content)_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5">
        <dt className="text-[13px] text-text-2">Pack reads</dt>
        <dd className="m-0 min-w-0">
          <Fields names={pack.reads} />
        </dd>
        <dt className="text-[13px] wrap-anywhere text-text-2">{`${source.name} reads`}</dt>
        <dd className="m-0 min-w-0">
          <Fields names={source.read} />
        </dd>
      </dl>
      {fields.missing.length === 0 ? null : (
        <p id={warningId} className="m-0 max-w-[68ch] border-l-2 border-review pl-3">
          {fields.present.length === 0 ? (
            `${source.name} has none of the fields the pack reads: these questions would have nothing to read.`
          ) : (
            <>
              {`${source.name} has no `}
              <Fields names={fields.missing} last=" or " />
              {": these questions would see only "}
              <Fields names={fields.present} last=" and " />.
            </>
          )}
        </p>
      )}
    </section>
  );
}

/** The packs could not be read: the worker's words when it refused, plain words when it was not reached. */
export function PacksUnreadable({
  error,
  retry,
}: {
  readonly error: Error;
  readonly retry: () => void;
}) {
  return (
    <div role="alert" className="grid justify-items-start gap-1.5 border-l-2 border-no pl-3">
      <p className="m-0 font-bold">The packs could not be read.</p>
      <p className="m-0 max-w-[68ch] text-text-2">
        {error instanceof ApiError ? (
          `${error.message} ${error.fix}`
        ) : (
          <>
            The studio cannot reach the worker. Check that it is running (
            <code className="font-mono text-[12.5px]">facetdb worker</code>) and that this computer
            is online.
          </>
        )}
      </p>
      <Button size="small" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

function NoPack() {
  return (
    <div className="grid gap-2">
      <p className="m-0">
        No installed plugin has a pack. Run one of these in the project's folder:
      </p>
      <ul className="m-0 grid list-none p-0">
        {PACK_PLUGINS.map((entry) => (
          <li key={entry.pack} className={`${ROW} ${FIRST_ROW}`}>
            <span className="grid min-w-0 flex-[1_1_200px] gap-1">
              <strong className="font-semibold">{entry.pack}</strong>
              <span className="text-[12.5px] text-text-2">{entry.words}</span>
            </span>
            <div className="min-w-0 flex-[1_1_240px]">
              <CommandLine command={entry.command} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The dialog's content, mounted at each opening: no pack chosen, the packs read again. */
function PackChooser({
  source,
  form,
  onAdd,
}: {
  readonly source: ConfigSource;
  readonly form: SourceForm;
  readonly onAdd: (next: { readonly form: SourceForm; readonly added: readonly string[] }) => void;
}) {
  const api = useApi();
  const id = useId();
  const packs = useQuery(packsQuery(api));
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const list = packs.data;
  const pack = list?.find((candidate) => keyOf(candidate) === chosen);
  const inFile = Object.keys(source.questions);
  const questions = pack === undefined ? [] : packQuestions(pack, form, inFile);
  const adding = questions.filter((entry) => entry.kept === null).length;
  const warningId = `${id}-warning`;
  const warned = pack !== undefined && (fieldsOf(pack, source.read)?.missing.length ?? 0) > 0;

  let body: ReactNode;
  if (list === undefined) {
    body =
      packs.isError && !packs.isFetching ? (
        <PacksUnreadable
          error={packs.error}
          retry={() => {
            void packs.refetch();
          }}
        />
      ) : (
        <p role="status" className="m-0 text-text-2">
          Reading the packs.
        </p>
      );
  } else if (list.length === 0) {
    body = <NoPack />;
  } else {
    body = (
      <>
        <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-[13px] text-text-2">Pack</legend>
          <div className="grid border-t border-hairline">
            {list.map((candidate, index) => {
              const key = keyOf(candidate);
              // An id is one word: the list's order names the row, the key names the pack.
              const nameId = `${id}-pack-${String(index)}-name`;
              const lineId = `${id}-pack-${String(index)}-line`;
              return (
                <label
                  key={key}
                  className={`${focusBrackets} grid cursor-pointer grid-cols-[16px_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-b border-hairline py-3 has-[:focus-visible]:after:opacity-100!`}
                >
                  <input
                    type="radio"
                    name={`${id}-pack`}
                    value={key}
                    checked={chosen === key}
                    aria-labelledby={nameId}
                    {...(candidate.description === null ? {} : { "aria-describedby": lineId })}
                    className="mt-0.75 size-4 accent-facet focus-visible:outline-2 focus-visible:outline-transparent"
                    onChange={() => {
                      setChosen(key);
                    }}
                  />
                  <span className="grid min-w-0 gap-1">
                    <strong id={nameId} className="font-semibold">
                      {labelOf(candidate, list)}
                    </strong>
                    {candidate.description === null ? null : (
                      <span id={lineId} className="text-[12.5px] text-text-2">
                        <Ticked text={firstSentence(candidate.description)} />
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {pack === undefined ? null : (
          <>
            <PackQuestions questions={questions} />
            <PackFields pack={pack} source={source} warningId={warningId} />
          </>
        )}
      </>
    );
  }

  return (
    <div className="grid gap-4.5">
      {body}
      <div className="fdb-dialog-actions">
        <DialogClose asChild>
          <Button variant="quiet">Cancel</Button>
        </DialogClose>
        <Button
          variant="primary"
          disabled={pack === undefined || adding === 0}
          {...(warned ? { "aria-describedby": warningId } : {})}
          onClick={() => {
            if (pack !== undefined) {
              onAdd(withPack(form, pack, inFile));
            }
          }}
        >
          {pack === undefined
            ? "Add to the draft"
            : adding === 0
              ? "Nothing to add"
              : `Add ${plural(adding, "question", "questions")}`}
        </Button>
      </div>
    </div>
  );
}

export function StartFromAPack({
  source,
  form,
  onAdd,
}: {
  readonly source: ConfigSource;
  /** The source's draft as it stands: the names a pack's questions are checked against. */
  readonly form: SourceForm;
  /** The draft with the pack's new questions, and their names; the dialog closes after it. */
  readonly onAdd: (next: { readonly form: SourceForm; readonly added: readonly string[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      title={`Start from a pack: ${source.name}`}
      description="Copies a pack's questions into this draft. Nothing is written before Apply."
      trigger={<Button>Start from a pack</Button>}
      open={open}
      onOpenChange={setOpen}
    >
      <PackChooser
        source={source}
        form={form}
        onAdd={(next) => {
          onAdd(next);
          setOpen(false);
        }}
      />
    </Dialog>
  );
}
