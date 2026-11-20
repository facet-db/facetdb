import type { ReviewOpenQuestion } from "../../api/index.ts";

/**
 * The review keys: `y` and `n` answer a yes-or-no question, `1` to `9` an option or level, `s`
 * skips, `u` undoes, `q` leaves. This file decides which key reaches which answer and when the page
 * must not hear a key at all.
 */

/** One answer a key reaches. */
export type KeyedAnswer = {
  readonly key: string;
  readonly question: string;
  readonly value: boolean | string;
};

/**
 * The answers the keys reach, in the card's order. A key reaches the first open question that has
 * it (as the mockup's script does), so on a card with two yes-or-no questions `y` answers the
 * first and the second takes it once the first is decided; the buttons of a second question that a
 * key does not reach show no hint. Digits stop at 9: the terminal review waits for a second digit
 * when ten or more options exist, but a page that waits would leave a pressed key undone for a
 * moment, so options from the tenth on are reached with Tab or the pointer and carry no hint.
 */
export function keyedAnswers(open: readonly ReviewOpenQuestion[]): readonly KeyedAnswer[] {
  const reached: KeyedAnswer[] = [];
  const take = (answer: KeyedAnswer) => {
    if (!reached.some((one) => one.key === answer.key)) {
      reached.push(answer);
    }
  };
  for (const question of open) {
    if (question.type === "noul") {
      take({ key: "y", question: question.name, value: true });
      take({ key: "n", question: question.name, value: false });
      continue;
    }
    question.options.slice(0, 9).forEach((option, index) => {
      take({ key: String(index + 1), question: question.name, value: option.name });
    });
  }
  return reached;
}

/** The hint a button shows: its key when the key reaches it. */
export function hintFor(
  reached: readonly KeyedAnswer[],
  question: string,
  value: boolean | string,
): string | undefined {
  return reached.find((one) => one.question === question && one.value === value)?.key;
}

// Where a key belongs to something else: a text field, and the listboxes (a Radix select jumps to
// the option that starts with the letter typed, even closed), dialogs and menus.
const OWNS_KEYS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="listbox"], [role="option"], [role="combobox"], [role="menu"], [role="menuitem"], [role="dialog"], [role="alertdialog"]';

/** Whether the key was pressed where typing or a widget owns it. */
export function ownsKeys(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OWNS_KEYS) !== null;
}

/** Whether a dialog is open anywhere: no key acts under one. */
export function dialogOpen(root: ParentNode): boolean {
  return root.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/**
 * The key a press means, or undefined when the page must not act on it: a modifier held (the
 * browser's and the system's shortcuts keep their keys), a held key repeating, a press that
 * something else already took, or a press where typing or a widget owns the key.
 */
export function pressedKey(event: KeyboardEvent): string | undefined {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return undefined;
  }
  if (ownsKeys(event.target) || dialogOpen(document)) {
    return undefined;
  }
  return event.key.length === 1 ? event.key.toLowerCase() : undefined;
}
