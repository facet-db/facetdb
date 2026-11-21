import { focusBrackets } from "@facetdb/ui";
import { Menu, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Brand, Instrument, PageLinks, ProjectPicker, ThemeSwitch } from "./Rail.tsx";

/**
 * The rail on a phone (the mockups' top bar): the brand, the project listbox and a menu button in a
 * bar along the top; the button opens a drawer under it with the pages at tap size, the worker and
 * spending lines and the theme switch. Escape closes it and gives the focus back to the button;
 * choosing a page closes it.
 */
export function Drawer() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const drawerId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-[9] flex flex-wrap items-center gap-3 border-b border-hairline bg-canvas px-4 py-2.5">
      <Brand />
      <div className="min-w-0 flex-1">
        <ProjectPicker bare />
      </div>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={drawerId}
        aria-label={open ? "Close the menu" : "Menu"}
        onClick={() => {
          setOpen(!open);
        }}
        className={`${focusBrackets} inline-flex size-9 flex-none cursor-pointer items-center justify-center border border-hairline bg-transparent text-text`}
      >
        {open ? (
          <X size={18} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Menu size={18} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
      <div
        id={drawerId}
        hidden={!open}
        className="grid basis-full gap-[18px] border-t border-hairline pt-3.5 pb-1.5"
      >
        {open ? (
          <>
            <PageLinks
              size="drawer"
              onNavigate={() => {
                setOpen(false);
              }}
            />
            <Instrument />
            <div>
              <ThemeSwitch />
            </div>
          </>
        ) : null}
      </div>
    </header>
  );
}
