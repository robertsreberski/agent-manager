import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, CodeXml, Mic, Paperclip, RotateCcw, Shield, Square } from "lucide-react";
import type { ReasoningEffort } from "@shared/session";
import type { CockpitProvider, ExecutionProfile } from "../../lib/cockpit-view";
import { isTypingTarget } from "../../lib/shortcuts";
import {
  ModelSelectorContent,
  ModelSelectorEffort,
  ModelSelectorList,
  ModelSelectorRoot,
  ModelSelectorTrigger,
  type ModelOption as ModelSelectorOption,
} from "../assistant-ui/model-selector";
import {
  applyCompletion,
  completionTrigger,
  composerPlaceholder,
  matchCommands,
  type CompletionTrigger,
} from "./mentions";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  RadioGroup,
  RadioGroupItem,
} from "../ui";

/*
  A withheld control still has to say why. `Button` disables pointer events so a
  disabled control cannot be hovered at all, which would swallow the native
  `title`; these two composer triggers opt back in. The reason is also printed
  as visible text in `data-withheld-reasons`, so the tooltip is the secondary
  channel, never the only one.
*/
const KEEPS_ITS_TOOLTIP = "disabled:pointer-events-auto disabled:cursor-default";

export type ComposerDelivery = "queue" | "steer";

export interface ComposerModelOption {
  value: string;
  label: string;
  description: string | null;
  isDefault?: boolean | undefined;
  defaultEffort?: ReasoningEffort | undefined;
  efforts?: readonly ReasoningEffort[] | undefined;
}

export interface SessionComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (delivery: ComposerDelivery) => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  isRunning: boolean;
  canQueue: boolean;
  canSteer: boolean;
  canStop: boolean;
  readOnlyReason?: string | null;
  provider: CockpitProvider;
  model: string | null;
  effort: ReasoningEffort | null;
  profile: ExecutionProfile | null;
  providerOptions?: readonly CockpitProvider[];
  modelOptions?: readonly ComposerModelOption[];
  modelOptionsStatus?: string | null;
  modelChangeUnavailableReason?: string | null;
  effortChangeUnavailableReason?: string | null;
  profileChangeUnavailableReason?: string | null;
  effortOptions?: readonly NonNullable<SessionComposerProps["effort"]>[];
  profileOptions?: readonly ExecutionProfile[];
  settingsIdleOnly?: boolean;
  draft?: boolean;
  busy?: boolean;
  onProviderChange?: (provider: CockpitProvider) => void;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: NonNullable<SessionComposerProps["effort"]>) => void;
  onProfileChange?: (profile: ExecutionProfile) => void;
  onResetSettings?: () => void;
  /**
   * Workspace-relative paths matching a query, for `@mention`. Absent where the
   * session has no readable workspace — a remote one, say — and the composer
   * then drops that half of frame 5a's placeholder rather than promising it.
   */
  onSearchFiles?: (query: string) => Promise<readonly string[]>;
}

const PROFILE_LABEL: Record<ExecutionProfile, string> = {
  "ask-first": "Ask first",
  plan: "Plan",
  execute: "Execute",
  "full-access": "Full access",
};

function profileLabel(profile: ExecutionProfile | null): string {
  return profile === null ? "Profile unknown" : PROFILE_LABEL[profile];
}

function effortBars(effort: SessionComposerProps["effort"]): number {
  return effort === "ultra" || effort === "max" || effort === "xhigh" || effort === "high" ? 3 : effort === "medium" ? 2 : effort === "low" || effort === "minimal" ? 1 : 0;
}

export function SessionComposer(props: SessionComposerProps) {
  const {
    value, onChange, onSend, onStop, isRunning, canQueue, canSteer, canStop,
    readOnlyReason, provider, model, effort, profile, providerOptions = ["codex", "claude"],
    modelOptions = [], modelOptionsStatus = null, effortOptions = ["low", "medium", "high"],
    modelChangeUnavailableReason = null, effortChangeUnavailableReason = null,
    profileChangeUnavailableReason = null,
    profileOptions = ["ask-first", "plan", "execute", "full-access"],
    settingsIdleOnly = false, draft = false, busy = false,
    onProviderChange, onModelChange, onEffortChange, onProfileChange, onResetSettings,
    onSearchFiles,
  } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The only state the composer still keeps for its menus: which one is open.
  // Radix owns focus, dismissal, roving tabindex and positioning; this exists
  // solely so ⌘⇧M and M can drive the same menus the triggers do, and so the
  // two menus stay mutually exclusive.
  const [openMenu, setOpenMenu] = useState<"runtime" | "profile" | null>(null);
  const settingsDisabled = !draft && settingsIdleOnly && isRunning;
  const runtimeHasAction = Boolean(onProviderChange || onModelChange || onEffortChange || onResetSettings);
  // A catalog the harness will not let this cockpit write is still worth
  // reading. The menu opens with every choice disabled and the exact reason.
  const runtimeIsReadable = modelOptions.length > 0 || Boolean(modelOptionsStatus);
  const runtimeDisabled = settingsDisabled || (!runtimeHasAction && !runtimeIsReadable);
  const profileDisabled = settingsDisabled || !onProfileChange;
  const runtimeDisabledReason = settingsDisabled
    ? "Available when this turn finishes"
    : modelChangeUnavailableReason ?? effortChangeUnavailableReason ?? "This harness does not expose live model or effort changes.";
  const profileDisabledReason = settingsDisabled
    ? "Available when this turn finishes"
    : profileChangeUnavailableReason ?? "This harness does not expose live execution-profile changes.";
  // A native tooltip is invisible on touch and to screen readers, so every
  // withheld control states its reason as plain text in the composer itself.
  const withheldReasons = [...new Set([
    runtimeDisabled ? runtimeDisabledReason : null,
    profileDisabled ? profileDisabledReason : null,
  ].flatMap((reason) => reason && reason !== readOnlyReason ? [reason] : []))];
  /*
    The provider's catalog in the selector's shape. Efforts hang off the model
    because that is where the component looks for them, and a model the harness
    will not let this cockpit write is still worth reading — it appears
    disabled, with the reason stated below the list.
  */
  const selectorModels: ModelSelectorOption[] = modelOptions.map((option) => ({
    id: option.value,
    name: option.label,
    // The id disambiguates two models with the same friendly name, so it stays
    // visible — the menu this replaced printed it on its own line — and it is
    // searchable alongside the label.
    description: option.description ? `${option.value} · ${option.description}` : option.value,
    keywords: [option.value],
    ...(onModelChange ? {} : { disabled: true }),
    ...(effortOptions.length > 0
      ? { efforts: effortOptions.map((level) => ({ id: level, name: level })) }
      : {}),
  }));
  const sendDisabled = busy || value.trim().length === 0 || !canQueue;
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(120, Math.max(52, element.scrollHeight))}px`;
  }, [value]);

  /*
    Frame 5a's placeholder promises `@mention files, run /commands`. Both are
    real here, and the placeholder only names the half that this session can
    actually do: a workspace the cockpit cannot read offers no files, and a
    provider whose command set is unknown offers no commands.
  */
  const [trigger, setTrigger] = useState<CompletionTrigger | null>(null);
  const [files, setFiles] = useState<readonly string[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const commands = trigger?.kind === "command" ? matchCommands(provider, trigger.query) : [];
  const suggestions: readonly string[] = trigger?.kind === "file"
    ? files
    : commands.map((command) => command.name);
  useEffect(() => {
    setHighlighted(0);
    if (trigger?.kind !== "file" || !onSearchFiles) { setFiles([]); return; }
    let cancelled = false;
    const query = trigger.query;
    // The operator keeps typing while a walk is in flight; a stale answer must
    // never replace the one for what is on screen now.
    const timer = setTimeout(() => {
      void onSearchFiles(query)
        .then((paths) => { if (!cancelled) setFiles(paths); })
        .catch(() => { if (!cancelled) setFiles([]); });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [onSearchFiles, trigger?.kind, trigger?.query]);

  function syncTrigger(element: HTMLTextAreaElement) {
    setTrigger(completionTrigger(element.value, element.selectionStart ?? element.value.length));
  }

  function choose(choice: string) {
    const element = textareaRef.current;
    if (!element || !trigger) return;
    const caret = element.selectionStart ?? element.value.length;
    const next = applyCompletion(value, caret, trigger, choice);
    onChange(next.value);
    setTrigger(null);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        textareaRef.current?.focus();
        return;
      }
      if (isTypingTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "m") {
        if (runtimeDisabled) return;
        event.preventDefault();
        setOpenMenu((current) => current === "runtime" ? null : "runtime");
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "m") {
        if (profileDisabled) return;
        event.preventDefault();
        setOpenMenu((current) => current === "profile" ? null : "profile");
      } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === "." && isRunning && canStop) {
        event.preventDefault();
        void onStop?.();
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [canStop, isRunning, onStop, profileDisabled, runtimeDisabled]);

  async function send(delivery: ComposerDelivery) {
    if (!value.trim() || busy) return;
    if (delivery === "steer" && !canSteer) return;
    if (delivery === "queue" && !canQueue) return;
    await onSend(delivery);
  }

  function keyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // While the picker is open it owns the arrows, Enter, Tab and Escape. It
    // must not reach the delivery path below: Enter there would send the
    // half-typed `@src/` rather than complete it.
    if (trigger && suggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlighted((current) => (current + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        choose(suggestions[highlighted]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setTrigger(null);
        return;
      }
    }
    if (event.key === "Enter" && (!event.shiftKey || event.metaKey)) {
      const delivery = event.metaKey && event.shiftKey ? "steer" : "queue";
      const supported = delivery === "steer" ? canSteer : canQueue;
      // Preserve the draft when assistant-ui's queue adapter cannot deliver.
      event.preventDefault();
      if (supported) void send(delivery);
      return;
    }
    if (event.key === "." && event.metaKey) {
      event.preventDefault();
      if (isRunning && canStop) void onStop?.();
    }
  }

  return (
    <div className="rounded-composer border border-[var(--border-hairline)] bg-[var(--surface-raised-hover)] px-3.5 pt-3.5 pb-2.5" data-session-composer>
      {readOnlyReason && (
        <p className="mb-2 text-meta-sm text-[var(--text-muted)]" role="status">{readOnlyReason}</p>
      )}
      {withheldReasons.length > 0 && (
        <p className="mb-2 text-code-sm text-[var(--text-muted)]" role="status" data-withheld-reasons>{withheldReasons.join(" · ")}</p>
      )}
      {trigger && suggestions.length > 0 && (
        <ul
          className="mb-2 max-h-52 min-w-0 overflow-y-auto overscroll-contain border border-[var(--border)] bg-[var(--menu)]"
          role="listbox"
          aria-label={trigger.kind === "file" ? "Workspace files" : "Provider commands"}
          data-composer-completions={trigger.kind}
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                data-compact-control="height"
                className={`flex min-h-9 w-full min-w-0 items-baseline gap-2 px-2.5 py-1.5 text-left font-mono text-code-sm ${index === highlighted ? "bg-[var(--surface-selected)] text-[var(--text)]" : "text-[var(--text-secondary)]"}`}
                onMouseEnter={() => setHighlighted(index)}
                // Blur would close the picker before the click landed.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(suggestion)}
              >
                <span className="min-w-0 flex-1 truncate">{trigger.kind === "file" ? suggestion : `/${suggestion}`}</span>
                {trigger.kind === "command" && (
                  <span className="shrink-0 font-sans text-meta-sm text-[var(--text-muted)]">
                    {commands[index]?.description}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => { onChange(event.target.value); syncTrigger(event.target); }}
        onKeyDown={keyDown}
        onKeyUp={(event) => syncTrigger(event.currentTarget)}
        onClick={(event) => syncTrigger(event.currentTarget)}
        onBlur={() => setTrigger(null)}
        disabled={Boolean(readOnlyReason) || busy}
        className="block min-h-[52px] max-h-[120px] w-full resize-none overflow-y-auto border-0 bg-transparent px-0.5 pt-0 pb-2.5 text-body text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
        aria-label="Message"
        aria-autocomplete="list"
        aria-expanded={Boolean(trigger && suggestions.length > 0)}
        placeholder={readOnlyReason ? "This session is read-only" : isRunning ? "Queue a message…" : composerPlaceholder(provider, Boolean(onSearchFiles))}
      />
      <div className="flex min-w-0 items-center gap-2.5 sm:gap-3.5">
        {/*
          assistant-ui's ModelSelector, composed rather than taken whole: its
          default export registers the selection into `ModelContext`, where it
          would ride on `config.modelName` in every chat request. A model change
          here is an explicit, capability-gated action against the harness, so
          that registration must not happen.

          The component has no notion of a withheld capability, so the gate
          stays outside it — the trigger is disabled with the harness's own
          reason, and that reason is also stated as text above, because a native
          tooltip is invisible on touch and to screen readers.
        */}
        <ModelSelectorRoot
          models={selectorModels}
          {...(model ? { value: model } : {})}
          onValueChange={(next) => onModelChange?.(next)}
          {...(effort ? { effort } : {})}
          onEffortChange={(next) => onEffortChange?.(next as NonNullable<SessionComposerProps["effort"]>)}
          open={openMenu === "runtime"}
          onOpenChange={(next) => { if (!runtimeDisabled || !next) setOpenMenu(next ? "runtime" : null); }}
        >
          <ModelSelectorTrigger
            data-compact-control
            disabled={runtimeDisabled}
            // A combobox does not take its name from its contents, so the
            // harness and model have to be stated for anyone not reading the
            // tile. The dropdown this replaced was a button, which did.
            aria-label={model ? `${provider}, model ${model}` : provider}
            className={`inline-flex h-auto min-h-8 min-w-0 items-center gap-2 rounded-full px-1.5 text-left text-meta text-[var(--text)] hover:bg-[var(--surface-selected-hover)] disabled:pointer-events-none disabled:opacity-45 data-[state=open]:bg-[var(--surface-selected)] sm:px-2 ${KEEPS_ITS_TOOLTIP}`}
            {...(runtimeDisabled ? { title: runtimeDisabledReason } : {})}
          >
            {/* Frames 5a, 9a-2 and 9b fill this tile lime, with the CodeXml glyph. */}
            <span className="grid size-[17px] shrink-0 place-items-center bg-[var(--accent)] text-[var(--accent-ink)]" data-provider-mark>
              <CodeXml size={11} strokeWidth={2} />
            </span>
            <span className="shrink-0 font-medium capitalize">{provider}</span>
            {model && <span className="hidden min-w-0 max-w-28 truncate text-[var(--text-muted)] sm:inline">{model}</span>}
          </ModelSelectorTrigger>
          <ModelSelectorContent side="top" align="start" aria-label="Harness, model, and effort" className="w-[22rem] max-w-[calc(100vw-2rem)]">
            {draft && providerOptions.length > 0 && (
              <div className="border-b border-[var(--rule)] p-1">
                <RadioGroup className="flex gap-1" value={provider} onValueChange={(next: string) => onProviderChange?.(next as CockpitProvider)} aria-label="Harness">
                  {providerOptions.map((option) => (
                    <label key={option} className="flex min-h-8 flex-1 cursor-pointer items-center gap-2 rounded-sm px-2 text-meta-sm capitalize hover:bg-[var(--surface-selected)]">
                      <RadioGroupItem value={option} disabled={!onProviderChange} />{option}
                    </label>
                  ))}
                </RadioGroup>
              </div>
            )}
            <ModelSelectorList />
            <ModelSelectorEffort />
            {modelOptions.length === 0 && modelOptionsStatus && <p className="px-2.5 py-1.5 text-code-sm text-[var(--text-muted)]" role="status">{modelOptionsStatus}</p>}
            {!onModelChange && modelChangeUnavailableReason && <p className="px-2.5 py-1.5 text-code-sm text-[var(--text-muted)]">{modelChangeUnavailableReason}</p>}
            {!onEffortChange && effortChangeUnavailableReason && <p className="px-2.5 py-1.5 text-code-sm text-[var(--text-muted)]">{effortChangeUnavailableReason}</p>}
            {onResetSettings && (
              <div className="border-t border-[var(--rule)] p-1">
                <Button variant="ghost" size="sm" data-compact-control="height" disabled={settingsDisabled} className="w-full justify-start gap-2 text-meta-sm text-[var(--text-muted)]" onClick={() => onResetSettings()}>
                  <RotateCcw size={12} aria-hidden="true" />Reset to configured defaults
                </Button>
              </div>
            )}
          </ModelSelectorContent>
        </ModelSelectorRoot>
        <span className="flex shrink-0 items-end gap-0.5" role="img" aria-label={`${effort ?? "unknown"} effort`}>
          {/* Frames 5a and 9a-2 fill the reached bars lime. */}
          {[1, 2, 3].map((bar) => <span key={bar} data-effort-bar={bar <= effortBars(effort) ? "active" : "inactive"} className={`w-[3px] ${bar <= effortBars(effort) ? "h-[11px] bg-[var(--accent)]" : "h-[7px] bg-[var(--border-strong)]"}`} />)}
        </span>
        <span className="h-3.5 w-px shrink-0 bg-[var(--border)]" />
        <DropdownMenu open={openMenu === "profile"} onOpenChange={(next) => setOpenMenu(next ? "profile" : null)}>
          <DropdownMenuTrigger asChild disabled={profileDisabled}>
            <Button
              variant="ghost"
              size="sm"
              data-compact-control
              className={`h-auto min-h-8 gap-1.5 rounded-full px-2 text-meta data-[state=open]:bg-[var(--surface-selected)] ${KEEPS_ITS_TOOLTIP}`}
              title={profileDisabled ? profileDisabledReason : undefined}
            >
              <span className={profile === "full-access" ? "text-[var(--access)]" : "text-[var(--text-secondary)]"}>{profileLabel(profile)}</span>
              <ChevronDown size={12} strokeWidth={1.75} className="text-[var(--text-faint)]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" aria-labelledby={undefined} aria-label="Execution profile" className="min-w-48">
            <DropdownMenuRadioGroup value={profile ?? ""} onValueChange={(next) => onProfileChange?.(next as ExecutionProfile)}>
              {profileOptions.map((option, index) => (
                <DropdownMenuRadioItem key={option} value={option} className={option === "full-access" ? "text-[var(--access)]" : ""}>
                  {PROFILE_LABEL[option]}
                  <DropdownMenuShortcut>{index + 1}</DropdownMenuShortcut>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {profile === "full-access" && (
          <span className="hidden shrink-0 items-center gap-1 bg-[var(--access-field)] px-2 py-1 text-code-xs whitespace-nowrap text-[var(--access)] lg:flex"><Shield size={11} />Full access</span>
        )}
        <span className="min-w-0 flex-1" />
        <span className="hidden shrink-0 font-mono text-code-sm whitespace-nowrap text-[var(--text-muted)] md:inline">{isRunning ? "queues while running" : "↵ sends"}</span>
        {/* Both are withheld capabilities, not decoration: they stay visible, disabled, and say why. */}
        <Button variant="ghost" size="icon" disabled aria-label="Attach files unavailable" title="Attachments are not supported by this harness" className={`hidden size-8 text-[var(--text-faint)] sm:inline-flex ${KEEPS_ITS_TOOLTIP}`}><Paperclip size={16} strokeWidth={1.75} /></Button>
        <Button variant="ghost" size="icon" disabled aria-label="Dictation unavailable" title="Dictation is not configured" className={`hidden size-8 text-[var(--text-faint)] sm:inline-flex ${KEEPS_ITS_TOOLTIP}`}><Mic size={16} strokeWidth={1.75} /></Button>
        {isRunning && canStop ? (
          <Button variant="ghost" size="icon" data-compact-control className="size-[30px] rounded-full bg-[var(--text)] text-[var(--app)] hover:bg-[var(--text-secondary)] hover:text-[var(--app)]" aria-label="Stop turn" onClick={() => void onStop?.()}><Square size={11} strokeWidth={2} /></Button>
        ) : (
          <Button variant="primary" size="icon" data-compact-control disabled={sendDisabled} className="size-[30px]" aria-label={isRunning ? "Queue message" : "Send message"} onClick={() => void send("queue")}><ArrowUp size={15} strokeWidth={2} /></Button>
        )}
      </div>
    </div>
  );
}
