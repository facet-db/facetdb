import * as RadixToast from "@radix-ui/react-toast";
import { X } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { focusBrackets } from "./Button.tsx";
import { type StatusKind, StatusWord } from "./StatusWord.tsx";

export type ToastSeverity = Extract<StatusKind, "critical" | "warning" | "information">;

export type ToastProviderProps = {
  children: ReactNode;
  // Names the notification region for a screen reader.
  label?: string;
  // How long a toast stays, in ms, unless its own `duration` says otherwise. A critical toast
  // ignores this default and stays until dismissed; only its own `duration` shortens it.
  duration?: number;
};

// The one provider per surface, with the viewport the toasts stack in at the bottom of the
// window. F8 moves the focus into the viewport (Radix's hotkey); Escape dismisses a focused toast.
export function ToastProvider({ children, label = "Notification", duration }: ToastProviderProps) {
  return (
    <RadixToast.Provider label={label} {...(duration === undefined ? {} : { duration })}>
      {children}
      <RadixToast.Viewport className="fdb-toast-viewport" />
    </RadixToast.Provider>
  );
}

// The one link to the page where it is fixed: an element the page makes (an anchor, or its
// router's link, so no click reloads the app) and the words that tell a screen reader user how
// else to reach it, since the toast may leave before they can navigate to the link.
export type ToastAction = { element: ReactElement; altText: string };

export type ToastProps = {
  action?: ToastAction;
  // The alert shape: what happened, where, what FacetDB did about it, and one link to the page
  // where it is fixed.
  what: string;
  where: string;
  did: string;
  severity?: ToastSeverity;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  // Critical alerts stay until dismissed; the others leave after the provider's duration.
  duration?: number;
};

// A Radix toast in the alert's shape. A critical one is announced at once (an assertive live
// region), the others politely; the severity is a word and a square, never a color alone.
export function Toast({
  what,
  where,
  did,
  action,
  severity = "information",
  open,
  defaultOpen,
  onOpenChange,
  duration,
}: ToastProps) {
  const root = {
    ...(open === undefined ? {} : { open }),
    ...(defaultOpen === undefined ? {} : { defaultOpen }),
    ...(onOpenChange === undefined ? {} : { onOpenChange }),
    ...(duration === undefined && severity !== "critical"
      ? {}
      : { duration: duration ?? Number.POSITIVE_INFINITY }),
  };
  return (
    <RadixToast.Root
      className={`fdb-toast ${focusBrackets}`}
      type={severity === "critical" ? "foreground" : "background"}
      {...root}
    >
      <RadixToast.Title className="fdb-toast-what">
        <StatusWord status={severity} size="small" /> {what}
      </RadixToast.Title>
      <RadixToast.Description className="fdb-toast-detail">
        {where}. {did}{" "}
        {action === undefined ? null : (
          <RadixToast.Action
            asChild
            altText={action.altText}
            className={`fdb-toast-link ${focusBrackets}`}
          >
            {action.element}
          </RadixToast.Action>
        )}
      </RadixToast.Description>
      <div className="fdb-toast-side">
        <RadixToast.Close className={`fdb-toast-close ${focusBrackets}`} aria-label="Dismiss">
          <X size={14} strokeWidth={1.6} aria-hidden />
        </RadixToast.Close>
      </div>
    </RadixToast.Root>
  );
}
