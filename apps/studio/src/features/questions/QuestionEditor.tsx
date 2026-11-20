import { Button, Listbox, Tag, ThresholdSlider } from "@facetdb/ui";
import { useId } from "react";
import type { DraftIssue, ThresholdOverride } from "../../api/index.ts";
import {
  cutProblem,
  defaultsOf,
  type Line,
  movedOverride,
  type QuestionForm,
  type QuestionType,
  type Stakes,
  thresholdsOf,
} from "./draft.ts";
import { FieldProblem, TextField } from "./fields.tsx";
import { type IssueField, issuePlace, stakesWords, TYPE_WORDS } from "./words.ts";

/**
 * One question of the draft: its name and kind, the question, its criteria or its options or
 * levels, what a wrong answer costs, and the threshold slider whose counts come from the preview's
 * probabilities, on the page, with no call. A question already in the file keeps its name and kind
 * (each is a column); a question added here takes both.
 */

const TYPES: readonly QuestionType[] = ["noul", "choice", "score"];

const percent = (figure: number): string => `${String(Math.round(figure * 100))}%`;

/** A threshold in words: "yes at or above 95%", "decide at 60% confidence". */
function cutWords(thresholds: ThresholdOverride): string {
  return [
    ...(thresholds.yesAbove === undefined
      ? []
      : [`yes at or above ${percent(thresholds.yesAbove)}`]),
    ...(thresholds.noBelow === undefined ? [] : [`no at or below ${percent(thresholds.noBelow)}`]),
    ...(thresholds.confidenceAtLeast === undefined
      ? []
      : [`decide at ${percent(thresholds.confidenceAtLeast)} confidence`]),
  ].join(", ");
}

/**
 * What the card says of a cut set by hand: it overrides the stakes' default, which is named, so a
 * change of the stakes never hides that the cut in force is not theirs.
 */
function handSetWords(question: QuestionForm): string | undefined {
  if (Object.keys(question.thresholds).length === 0) {
    return undefined;
  }
  const defaults = defaultsOf(question);
  const standard =
    defaults.kind === "cuts"
      ? { yesAbove: defaults.yesAbove, noBelow: defaults.noBelow }
      : { confidenceAtLeast: defaults.confidenceAtLeast };
  return `A cut set by hand overrides the stakes' default: ${cutWords(question.thresholds)}. At ${question.stakes} stakes the default is ${cutWords(standard)}.`;
}

/** The loader's problems about this question, by the field they stand under. */
function problemsByField(issues: readonly DraftIssue[], name: string) {
  const by = new Map<IssueField, string[]>();
  for (const issue of issues) {
    const place = issuePlace(issue);
    if (place?.question === name) {
      by.set(place.field, [...(by.get(place.field) ?? []), issue.message]);
    }
  }
  const words = (field: IssueField) => {
    const listed = by.get(field);
    return listed === undefined ? undefined : listed.join(" ");
  };
  return words;
}

function LinesEditor({
  heading,
  noun,
  lines,
  onChange,
  problem,
  describedRequired,
}: {
  readonly heading: string;
  /** "option", "level": what one line is called. */
  readonly noun: string;
  readonly lines: readonly Line[];
  readonly onChange: (lines: readonly Line[]) => void;
  readonly problem: string | undefined;
  /** An option needs its line; a level may go without. */
  readonly describedRequired: boolean;
}) {
  const id = useId();
  const set = (index: number, line: Line) => {
    onChange(lines.map((existing, at) => (at === index ? line : existing)));
  };
  return (
    <fieldset
      className="m-0 grid min-w-0 gap-2 border-0 p-0"
      {...(problem === undefined ? {} : { "aria-describedby": `${id}-problem` })}
    >
      <legend className="mb-1.5 p-0 text-[13px] text-text-2">{heading}</legend>
      {lines.map((line, index) => {
        const place = `${noun} ${String(index + 1)}`;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a line is its place in the list; its name is what is being typed
            key={index}
            className="grid grid-cols-[minmax(0,2fr)_minmax(0,5fr)_auto] items-end gap-2"
          >
            <TextField
              label={`${place}, its name`}
              labelHidden
              placeholder="name"
              value={line.name}
              onChange={(name) => {
                set(index, { ...line, name });
              }}
            />
            <TextField
              label={`${place}, the line the model reads`}
              labelHidden
              placeholder={describedRequired ? "what it means" : "what it means, if it helps"}
              value={line.description}
              onChange={(description) => {
                set(index, { ...line, description });
              }}
            />
            <Button
              variant="quiet"
              size="small"
              aria-label={`Remove ${place}`}
              disabled={lines.length <= 2}
              onClick={() => {
                onChange(lines.filter((_, at) => at !== index));
              }}
            >
              Remove
            </Button>
          </div>
        );
      })}
      {problem === undefined ? null : <FieldProblem id={`${id}-problem`} words={problem} />}
      <div>
        <Button
          variant="quiet"
          size="small"
          onClick={() => {
            onChange([...lines, { name: "", description: "" }]);
          }}
        >
          {`Add ${noun === "option" ? "an option" : "a level"}`}
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * A question's thresholds: the slider over the preview's figures for this question, counted on the
 * page with no call, the words of a cut set by hand, and the problems tied to them.
 */
export function QuestionThresholds({
  question,
  onChange,
  fileOverride,
  figures,
  previewed,
  problem,
  heading,
}: {
  readonly question: QuestionForm;
  readonly onChange: (next: QuestionForm) => void;
  /** The thresholds the file holds for this question; none for a question added here. */
  readonly fileOverride: ThresholdOverride;
  readonly figures: readonly number[];
  readonly previewed: boolean;
  /** The loader's words about the thresholds; undefined when it has none. */
  readonly problem: string | undefined;
  /** What the slider is headed by: "Thresholds" unless given (the setup names the question). */
  readonly heading?: string;
}) {
  const id = useId();
  const thresholds = thresholdsOf(question);
  const handSet = handSetWords(question);
  const crossing = cutProblem(question);
  return (
    // A group named by its legend, so each question's sliders are told apart by more than
    // "Yes at or above" where several questions stand together (the setup's step four).
    <fieldset className="m-0 grid min-w-0 gap-1.5 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] text-text-2">
        {heading ?? (thresholds.kind === "cuts" ? "Thresholds" : "Threshold")}
      </legend>
      {crossing === undefined ? (
        <ThresholdSlider
          question={question.name}
          value={thresholds}
          probabilities={figures}
          onChange={(next) => {
            onChange({ ...question, thresholds: movedOverride(question, fileOverride, next) });
          }}
        />
      ) : (
        // Cut lines that cross are never drawn, nor do they decide a row: the problem stands
        // in their place until the stakes or the default put them in order.
        <FieldProblem id={`${id}-crossing`} words={crossing} />
      )}
      {handSet === undefined ? null : (
        <div className="grid gap-1.5">
          <p className="m-0 text-[13px] text-text-2">{handSet}</p>
          <div>
            <Button
              variant="quiet"
              size="small"
              onClick={() => {
                onChange({ ...question, thresholds: {} });
              }}
            >
              Use the stakes' default
            </Button>
          </div>
        </div>
      )}
      {figures.length > 0 ? null : (
        <p className="m-0 text-[12.5px] text-text-3">
          {previewed
            ? "The last preview did not ask this question as it is now; its counts come with the next one."
            : "The counts come from the preview's rows: run the preview to see them."}
        </p>
      )}
      {problem === undefined ? null : (
        <FieldProblem id={`${id}-thresholds-problem`} words={problem} />
      )}
    </fieldset>
  );
}

export function QuestionEditor({
  question,
  onChange,
  onRemove,
  issues,
  nameProblem,
  fileOverride,
  figures,
  previewed,
  withThresholds = true,
}: {
  readonly question: QuestionForm;
  readonly onChange: (next: QuestionForm) => void;
  /** Only for a question added in this draft: one in the file is removed by hand. */
  readonly onRemove: (() => void) | undefined;
  /**
   * The threshold slider under the question, as the Questions page shows it; the setup flow sets
   * the thresholds in a step of their own (`QuestionThresholds`).
   */
  readonly withThresholds?: boolean;
  readonly issues: readonly DraftIssue[];
  /** Why this question's name cannot be sent (draft.ts, `nameProblem`); undefined when it can. */
  readonly nameProblem: string | undefined;
  /** The thresholds the file holds for this question; none for a question added here. */
  readonly fileOverride: ThresholdOverride;
  /** The preview's figures for this question (probabilities or confidences), none before a preview. */
  readonly figures: readonly number[];
  /** Whether a preview has been shown on this page. */
  readonly previewed: boolean;
}) {
  const id = useId();
  const problem = problemsByField(issues, question.name);
  const kind = TYPE_WORDS[question.type];
  const stakesId = `${id}-stakes`;
  const typeId = `${id}-type`;
  const questionProblem = problem("question");
  const thresholdProblem = problem("thresholds");

  return (
    <article className="grid min-w-0 gap-4" aria-labelledby={`${id}-name`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${id}-name`} className="m-0 text-[17px] font-bold">
          {question.existing ? question.name : `New question: ${question.name}`}
        </h2>
        <Tag tone={question.stakes === "high" ? "no" : "neutral"}>
          {`${kind}, ${question.stakes} stakes`}
        </Tag>
      </div>
      {questionProblem === undefined ? null : (
        <FieldProblem id={`${id}-question-problem`} words={questionProblem} />
      )}
      {question.existing ? null : (
        <>
          <TextField
            label="Name, the column's name"
            value={question.name}
            problem={nameProblem}
            onChange={(name) => {
              onChange({ ...question, name });
            }}
          />
          <div className="grid min-w-0 gap-1.5">
            <label htmlFor={typeId} className="text-[13px] text-text-2">
              Kind of answer
            </label>
            <Listbox
              id={typeId}
              label="Kind of answer"
              width="full"
              options={TYPES.map((type) => ({ value: type, label: TYPE_WORDS[type] }))}
              value={question.type}
              onValueChange={(value) => {
                const type = TYPES.find((candidate) => candidate === value);
                if (type !== undefined && type !== question.type) {
                  // Another kind has other thresholds: back to the stakes defaults.
                  onChange({ ...question, type, thresholds: {} });
                }
              }}
            />
          </div>
        </>
      )}
      <TextField
        label="Question"
        value={question.instructions}
        problem={problem("instructions")}
        onChange={(instructions) => {
          onChange({ ...question, instructions });
        }}
      />
      {question.type === "noul" ? (
        <>
          <TextField
            label="Yes when"
            rows={2}
            value={question.yes}
            problem={problem("criteria")}
            onChange={(yes) => {
              onChange({ ...question, yes });
            }}
          />
          <TextField
            label="No when"
            rows={2}
            value={question.no}
            onChange={(no) => {
              onChange({ ...question, no });
            }}
          />
        </>
      ) : null}
      {question.type === "choice" ? (
        <LinesEditor
          heading="Options, each with one line the model reads"
          noun="option"
          lines={question.options}
          problem={problem("options")}
          describedRequired
          onChange={(options) => {
            onChange({ ...question, options });
          }}
        />
      ) : null}
      {question.type === "score" ? (
        <LinesEditor
          heading="Levels, lowest first"
          noun="level"
          lines={question.levels}
          problem={problem("levels")}
          describedRequired={false}
          onChange={(levels) => {
            onChange({ ...question, levels });
          }}
        />
      ) : null}
      <div className="grid min-w-0 gap-1.5">
        <label htmlFor={stakesId} className="text-[13px] text-text-2">
          What happens when the answer is wrong?
        </label>
        <Listbox
          id={stakesId}
          label="What happens when the answer is wrong?"
          width="full"
          options={(["high", "low"] as const).map((stakes) => ({
            value: stakes,
            label: stakesWords(question.type, stakes),
          }))}
          value={question.stakes}
          onValueChange={(value) => {
            const stakes: Stakes = value === "high" ? "high" : "low";
            if (stakes !== question.stakes) {
              // A cut set by hand stands whatever the stakes; the card says it overrides them.
              onChange({ ...question, stakes });
            }
          }}
        />
      </div>
      {withThresholds ? (
        <QuestionThresholds
          question={question}
          onChange={onChange}
          fileOverride={fileOverride}
          figures={figures}
          previewed={previewed}
          problem={thresholdProblem}
        />
      ) : null}
      {onRemove === undefined ? null : (
        <div>
          <Button variant="quiet" size="small" onClick={onRemove}>
            {`Remove ${question.name}`}
          </Button>
        </div>
      )}
    </article>
  );
}
