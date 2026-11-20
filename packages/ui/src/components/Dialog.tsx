import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

// Closes the dialog it sits in: wrap a Button in it (`asChild`) for Cancel and the like.
export const DialogClose = RadixDialog.Close;

export type DialogProps = {
  // The heading, and the dialog's accessible name.
  title: string;
  // One sentence under it, also the dialog's accessible description.
  description?: string;
  children?: ReactNode;
  // The buttons at the foot, the primary last: <Button variant="primary">Apply</Button>.
  actions?: ReactNode;
  // The control that opens it (a Button); the focus returns to it when the dialog closes.
  trigger?: ReactNode;
  // Controlled with open and onOpenChange, or uncontrolled with defaultOpen.
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

// A Radix dialog, sharp, on the canvas: modal, the focus held inside and returned to the control
// that opened it, Escape and a click outside close it.
export function Dialog({
  title,
  description,
  children,
  actions,
  trigger,
  open,
  defaultOpen,
  onOpenChange,
}: DialogProps) {
  const root = {
    ...(open === undefined ? {} : { open }),
    ...(defaultOpen === undefined ? {} : { defaultOpen }),
    ...(onOpenChange === undefined ? {} : { onOpenChange }),
  };
  return (
    <RadixDialog.Root {...root}>
      {trigger === undefined ? null : <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fdb-dialog-overlay" />
        <RadixDialog.Content
          className="fdb-dialog"
          // Without a description, say so: Radix would warn about the missing one.
          {...(description === undefined ? { "aria-describedby": undefined } : {})}
        >
          <RadixDialog.Title className="fdb-dialog-title">{title}</RadixDialog.Title>
          {description === undefined ? null : (
            <RadixDialog.Description className="fdb-dialog-description">
              {description}
            </RadixDialog.Description>
          )}
          {children}
          {actions === undefined ? null : <div className="fdb-dialog-actions">{actions}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
