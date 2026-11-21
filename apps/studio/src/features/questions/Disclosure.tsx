import { Button } from "@facetdb/ui";
import { type ReactNode, useId, useState } from "react";

/**
 * Words for an engineer behind a quiet button (a sentence a person does not need stays off the
 * page, and one an engineer may still want is a click away): the worker's own sentence, the
 * terminal steps. The button says whether it is open (`aria-expanded`), as Decisions' "More
 * filters" does; the words are in the page, hidden, until it is.
 */
export function Disclosure({
  label,
  of,
  open: initiallyOpen = false,
  children,
}: {
  readonly label: string;
  /** What the words are about, where several such buttons sit together: "Details of listings". */
  readonly of?: string;
  /** Open from the start: where the page offers no way of its own, the steps are the way. */
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="grid min-w-0 justify-items-start gap-2">
      <Button
        variant="quiet"
        size="small"
        aria-label={of === undefined ? undefined : `${label} of ${of}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {label}
      </Button>
      <div id={id} hidden={!open} className="grid w-full min-w-0 gap-3">
        {children}
      </div>
    </div>
  );
}
