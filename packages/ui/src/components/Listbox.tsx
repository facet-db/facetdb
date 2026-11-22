import * as Select from "@radix-ui/react-select";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { ChevronDown } from "lucide-react";
import { useId } from "react";
import { focusBrackets } from "./Button.tsx";

export type ListboxOption = { value: string; label: string; disabled?: boolean };

export type ListboxProps = {
  // The accessible name of the control (the visible label, if any, sits beside it).
  label: string;
  options: readonly ListboxOption[];
  // Controlled with value and onValueChange, or uncontrolled with defaultValue.
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  // Shown, in the muted role, while nothing is chosen.
  placeholder?: string;
  // One line under the options ("This studio serves one project..."); also the trigger's
  // description for a screen reader, since the listbox itself holds options only.
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  // A form's refusal of the choice: the trigger is marked invalid (an `aria-invalid` the form can
  // move the focus to) and described by the element that says why, beside any hint.
  invalid?: boolean;
  describedBy?: string;
  // For a form post and a visible <label htmlFor>.
  id?: string;
  name?: string;
  // `fit` is as wide as the chosen option; `full` fills its container.
  width?: "fit" | "full";
  // `box` is the hairline rectangle; `rule` is the rail's project switcher (ruled above and below,
  // no sides, the name semi-bold); `bare` is the same without a rule, for the phone's top bar.
  variant?: "box" | "rule" | "bare";
};

// Radix Select with the brief's skin: a hairline rectangle with a drawn chevron, the options in a
// ruled list on the canvas under it, a `facet` square on the chosen one; the browser's popup never
// shows. Keys are Radix's: Arrow Down, Arrow Up, Enter and Space open the list from the trigger;
// inside it the arrows, Home and End move, Enter picks, Escape closes and returns the focus, typing
// a letter jumps to the option that starts with it.
export function Listbox({
  label,
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  hint,
  disabled,
  required,
  invalid = false,
  describedBy,
  id,
  name,
  width = "fit",
  variant = "box",
}: ListboxProps) {
  const hintId = useId();
  const described = [hint === undefined ? undefined : hintId, describedBy]
    .filter((one) => one !== undefined)
    .join(" ");
  const root = {
    ...(value === undefined ? {} : { value }),
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(onValueChange === undefined ? {} : { onValueChange }),
    ...(disabled === undefined ? {} : { disabled }),
    ...(required === undefined ? {} : { required }),
    ...(name === undefined ? {} : { name }),
  };
  const trigger = {
    ...(id === undefined ? {} : { id }),
    ...(described === "" ? {} : { "aria-describedby": described }),
    ...(invalid ? { "aria-invalid": true } : {}),
  };
  return (
    <Select.Root {...root}>
      <Select.Trigger
        className={`fdb-listbox ${focusBrackets}`}
        data-width={width}
        data-variant={variant}
        aria-label={label}
        {...trigger}
      >
        <Select.Value {...(placeholder === undefined ? {} : { placeholder })} />
        <Select.Icon asChild>
          {/* The mockups' chevron: a 1.6 px stroke at 12 px, whatever the icon's own grid */}
          <ChevronDown
            className="fdb-listbox-chevron"
            size={12}
            strokeWidth={1.6}
            absoluteStrokeWidth
            aria-hidden
          />
        </Select.Icon>
      </Select.Trigger>
      {hint === undefined ? null : <VisuallyHidden id={hintId}>{hint}</VisuallyHidden>}
      <Select.Portal>
        <Select.Content
          className="fdb-listbox-content"
          {...(hint === undefined ? {} : { "data-hint": "" })}
          position="popper"
          sideOffset={4}
          align="start"
        >
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item
                key={option.value}
                className="fdb-listbox-item"
                value={option.value}
                {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
          {hint === undefined ? null : (
            <p className="fdb-listbox-hint" aria-hidden="true">
              {hint}
            </p>
          )}
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
