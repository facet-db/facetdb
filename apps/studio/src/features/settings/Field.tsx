import { type ComponentProps, useId } from "react";

/** A refusal for one field: what is wrong, and what to do about it (the surface's two sentences). */
export type FieldProblem = { readonly message: string; readonly fix: string };

/**
 * A labelled text box (a label on every field, an error tied to its field and announced once). The
 * label is a real label; the help and the error are the box's description, and the error is an
 * alert that exists only while there is one, so it is read when it appears and not again. The focus
 * draws the corner brackets on the box's wrapper, since an input draws no pseudo-element of its
 * own.
 */
export function Field({
  label,
  help,
  problem,
  ...input
}: Omit<ComponentProps<"input">, "id" | "className" | "aria-describedby" | "aria-invalid"> & {
  readonly label: string;
  readonly help?: string;
  readonly problem?: FieldProblem | undefined;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const problemId = `${id}-problem`;
  const described = [help === undefined ? "" : helpId, problem === undefined ? "" : problemId]
    .filter((one) => one !== "")
    .join(" ");
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <label htmlFor={id} className="text-[13px] text-text-2">
        {label}
      </label>
      <span className="fdb-brackets relative block has-[:focus-visible]:after:opacity-100!">
        <input
          id={id}
          {...input}
          {...(described === "" ? {} : { "aria-describedby": described })}
          {...(problem === undefined ? {} : { "aria-invalid": true })}
          className="h-9 w-full border border-hairline bg-transparent px-3 text-text outline-offset-2 placeholder:text-text-3 hover:border-text-3 focus-visible:outline-2 focus-visible:outline-transparent"
        />
      </span>
      {help === undefined ? null : (
        <p id={helpId} className="text-[12.5px] text-text-2">
          {help}
        </p>
      )}
      {problem === undefined ? null : (
        <p id={problemId} role="alert" className="grid gap-1 border-l-2 border-no pl-3">
          <span>{problem.message}</span>
          <span className="text-text-2">{problem.fix}</span>
        </p>
      )}
    </div>
  );
}
