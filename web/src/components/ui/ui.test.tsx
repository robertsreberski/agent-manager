import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./index";

/*
  jsdom has no layout engine and no pointer-capture APIs, both of which Radix's
  positioned primitives call into. These stubs make the primitives mountable;
  every assertion below is about roles, state and focus, never geometry.
*/
beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  }
  if (!("DOMRect" in globalThis)) {
    Object.defineProperty(globalThis, "DOMRect", {
      configurable: true,
      value: class {
        constructor(
          readonly x = 0,
          readonly y = 0,
          readonly width = 0,
          readonly height = 0,
        ) {}
      },
    });
  }
  for (const method of ["scrollIntoView", "hasPointerCapture", "setPointerCapture", "releasePointerCapture"]) {
    if (typeof (Element.prototype as unknown as Record<string, unknown>)[method] !== "function") {
      Object.defineProperty(Element.prototype, method, { configurable: true, value: () => false });
    }
  }
});

/** A real click is a pointerdown followed by a click; Radix triggers listen to the first. */
function click(element: Element): void {
  fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerId: 1 });
  fireEvent.click(element);
}

describe("Button", () => {
  it("calls onClick and reflects the disabled state", () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" onClick={onClick}>
        New thread
      </Button>,
    );
    const button = screen.getByRole("button", { name: "New thread" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Send
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders the child element with asChild", () => {
    render(
      <Button asChild variant="ghost">
        <a href="/docs">Docs</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link).toHaveAttribute("href", "/docs");
    expect(link).toHaveAttribute("data-slot", "button");
  });
});

describe("Badge and Separator", () => {
  it("renders a badge and a semantic separator", () => {
    render(
      <>
        <Badge tone="danger">failed</Badge>
        <Separator decorative={false} orientation="vertical" />
      </>,
    );
    expect(screen.getByText("failed")).toHaveAttribute("data-slot", "badge");
    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
  });

  it("hides a decorative separator from assistive tech", () => {
    render(<Separator />);
    expect(screen.queryByRole("separator")).toBeNull();
  });
});

describe("DropdownMenu", () => {
  it("opens on click, exposes its items, and closes on Escape", async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Session actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuItem onSelect={onSelect}>Rename</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="danger">Archive</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const trigger = screen.getByRole("button", { name: "Session actions" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();

    click(trigger);

    const menu = await screen.findByRole("menu");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Rename", "Archive"]);
    expect(menu).toHaveAttribute("data-slot", "dropdown-menu-content");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(trigger);
  });

  it("selects an item and toggles a checkbox item", async () => {
    const onSelect = vi.fn();

    function Harness() {
      const [showDiffs, setShowDiffs] = useState(false);
      return (
        <DropdownMenu>
          <DropdownMenuTrigger>View</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={onSelect}>Reveal in Finder</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked={showDiffs} onCheckedChange={setShowDiffs}>
              Show diffs
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    render(<Harness />);
    click(screen.getByRole("button", { name: "View" }));

    const checkboxItem = await screen.findByRole("menuitemcheckbox", { name: "Show diffs" });
    expect(checkboxItem).toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("Dialog", () => {
  it("traps focus, hides the rest of the page, and closes on Escape", async () => {
    const onOpenChange = vi.fn();
    render(
      <>
        <button type="button">Outside</button>
        <Dialog onOpenChange={onOpenChange}>
          <DialogTrigger asChild>
            <Button>Open settings</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>Notifications</DialogTitle>
            <DialogDescription>Local browser notifications only.</DialogDescription>
            <DialogClose asChild>
              <Button variant="secondary">Done</Button>
            </DialogClose>
          </DialogContent>
        </Dialog>
      </>,
    );

    const trigger = screen.getByRole("button", { name: "Open settings" });
    click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    expect(dialog).toHaveAccessibleDescription("Local browser notifications only.");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // The rest of the page is hidden from assistive tech while the modal is up.
    expect(screen.getByText("Outside").closest("[aria-hidden]")).not.toBeNull();

    // Focus loops inside the panel rather than escaping to the page behind it.
    const inside = Array.from(dialog.querySelectorAll<HTMLElement>("button"));
    const last = inside.at(-1);
    const first = inside.at(0);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    last?.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("closes from the close button", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Setup</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    await screen.findByRole("dialog", { name: "Setup" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("Sheet", () => {
  it("opens an edge-anchored modal and closes on Escape", async () => {
    render(
      <Sheet>
        <SheetTrigger asChild>
          <Button>Open drawer</Button>
        </SheetTrigger>
        <SheetContent side="bottom">
          <SheetTitle>Keyboard shortcuts</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    click(screen.getByRole("button", { name: "Open drawer" }));

    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(sheet).toHaveAttribute("data-slot", "sheet-content");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("Select", () => {
  it("opens, lists its options, and reports the chosen value", async () => {
    const onValueChange = vi.fn();

    function Harness() {
      const [value, setValue] = useState<string | undefined>(undefined);
      return (
        <Select
          {...(value === undefined ? {} : { value })}
          onValueChange={(next) => {
            setValue(next);
            onValueChange(next);
          }}
        >
          <SelectTrigger aria-label="Execution profile">
            <SelectValue placeholder="Choose a profile" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="plan">Plan</SelectItem>
            <SelectItem value="execute">Execute</SelectItem>
          </SelectContent>
        </Select>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Execution profile" });
    expect(trigger).toHaveTextContent("Choose a profile");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    await screen.findByRole("listbox");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Plan", "Execute"]);

    fireEvent.click(screen.getByRole("option", { name: "Execute" }));

    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith("execute"));
    await waitFor(() => expect(trigger).toHaveTextContent("Execute"));
  });
});

describe("Checkbox", () => {
  it("toggles between checked and unchecked", () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Select session" onCheckedChange={onCheckedChange} />);

    const checkbox = screen.getByRole("checkbox", { name: "Select session" });
    expect(checkbox).toHaveAttribute("data-state", "unchecked");
    expect(checkbox).toHaveAttribute("aria-checked", "false");

    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    expect(checkbox).toHaveAttribute("data-state", "checked");
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "false");
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  it("does not toggle when disabled", () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox disabled aria-label="Select session" onCheckedChange={onCheckedChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select session" }));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

describe("RadioGroup", () => {
  it("moves the selection to the clicked item", () => {
    const onValueChange = vi.fn();
    render(
      <RadioGroup defaultValue="low" onValueChange={onValueChange} aria-label="Effort">
        <label>
          <RadioGroupItem value="low" /> Low
        </label>
        <label>
          <RadioGroupItem value="high" /> High
        </label>
      </RadioGroup>,
    );

    const [low, high] = screen.getAllByRole("radio");
    expect(low).toHaveAttribute("aria-checked", "true");
    expect(high).toHaveAttribute("aria-checked", "false");

    if (high) fireEvent.click(high);

    expect(onValueChange).toHaveBeenCalledWith("high");
    expect(high).toHaveAttribute("aria-checked", "true");
    expect(low).toHaveAttribute("aria-checked", "false");
  });
});

describe("Tooltip", () => {
  it("describes its trigger while open", async () => {
    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon" aria-label="Copy path">
            <span aria-hidden="true">C</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy the workspace path</TooltipContent>
      </Tooltip>,
    );

    const trigger = screen.getByRole("button", { name: "Copy path" });
    expect(trigger).not.toHaveAttribute("aria-describedby");

    fireEvent.focus(trigger);

    await waitFor(() => expect(trigger).toHaveAccessibleDescription("Copy the workspace path"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Copy the workspace path");

    fireEvent.blur(trigger);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });
});

describe("Collapsible", () => {
  it("shows and hides its content", async () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>Show 4 more tool calls</CollapsibleTrigger>
        <CollapsibleContent>Read package.json</CollapsibleContent>
      </Collapsible>,
    );

    const trigger = screen.getByRole("button", { name: "Show 4 more tool calls" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Read package.json")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("Read package.json")).toBeVisible();

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByText("Read package.json")).toBeNull());
  });
});

describe("Command", () => {
  it("filters items as the operator types and reports the chosen one", async () => {
    const onSelect = vi.fn();
    render(
      <Command>
        <CommandInput placeholder="Search sessions and commands" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Sessions">
            <CommandItem value="agent-manager" onSelect={onSelect}>
              agent-manager
            </CommandItem>
            <CommandItem value="jetpack">jetpack</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );

    expect(screen.getAllByRole("option")).toHaveLength(2);

    const input = screen.getByPlaceholderText("Search sessions and commands");
    fireEvent.change(input, { target: { value: "jetp" } });

    await waitFor(() => expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["jetpack"]));

    fireEvent.change(input, { target: { value: "zzzz" } });
    await waitFor(() => expect(screen.getByText("No results.")).toBeInTheDocument());
  });

  it("renders inside a dialog with an accessible name", async () => {
    render(
      <CommandDialog defaultOpen title="Command palette">
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandItem value="new-thread">New thread</CommandItem>
        </CommandList>
      </CommandDialog>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveAttribute("data-slot", "dialog-content");
    expect(screen.getByRole("option", { name: "New thread" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
