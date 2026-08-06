import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Command, CommandItem, CommandList } from "./command";

/*
  cmdk and Radix disagree about how a disabled item appears in the DOM, and the
  shared item styling used to assume Radix's form for both.

  Radix omits `data-disabled` unless the item really is disabled, so the
  presence selector `data-[disabled]:opacity-45` is exactly right there. cmdk
  writes `data-disabled="false"` on every item it renders, and a presence
  selector matches that string too — so every row of the model picker was
  rendered at 45% opacity with `pointer-events: none`, on every session, whether
  or not the harness allowed the change. The controls were never disabled; they
  were only painted and fenced as if they were.

  jsdom applies no Tailwind, so computed opacity cannot catch this. The class
  string is what carries the bug, so the class string is what these assert.
*/

describe("menu item disabled styling", () => {
  it("does not fence a cmdk item that reports data-disabled=false", () => {
    render(
      <Command>
        <CommandList>
          <CommandItem value="sonnet">Sonnet</CommandItem>
        </CommandList>
      </Command>,
    );
    const item = screen.getByText("Sonnet").closest("[data-slot='command-item']");
    expect(item).not.toBeNull();
    // cmdk's own signal for an enabled item.
    expect(item).toHaveAttribute("data-disabled", "false");

    const classes = item?.getAttribute("class") ?? "";
    // A presence selector would match `data-disabled="false"` and grey it out.
    expect(classes).not.toMatch(/data-\[disabled\]:opacity-45/u);
    expect(classes).not.toMatch(/data-\[disabled\]:pointer-events-none/u);
    // The value-based form is what cmdk actually emits when disabled.
    expect(classes).toMatch(/data-\[disabled=true\]:opacity-45/u);
    expect(classes).toMatch(/data-\[disabled=true\]:pointer-events-none/u);
  });

  it("still fences a cmdk item that reports data-disabled=true", () => {
    render(
      <Command>
        <CommandList>
          <CommandItem value="sonnet" disabled>Sonnet</CommandItem>
        </CommandList>
      </Command>,
    );
    const item = screen.getByText("Sonnet").closest("[data-slot='command-item']");
    expect(item).toHaveAttribute("data-disabled", "true");
    expect(item?.getAttribute("class") ?? "").toMatch(/data-\[disabled=true\]:opacity-45/u);
  });
});
