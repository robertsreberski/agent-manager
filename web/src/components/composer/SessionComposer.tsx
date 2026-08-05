import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, CodeXml, Paperclip, RotateCcw, Square } from "lucide-react";
import type { CodexSandboxMode, ReasoningEffort, SandboxPolicy } from "@shared/session";
import { CODEX_SANDBOX_MODES, sandboxPolicy } from "../../../../src/shared/session.ts";
import type { CockpitProvider, ExecutionProfile } from "../../lib/cockpit-view";
import { isTypingTarget } from "../../lib/shortcuts";
import { coveringModelOption } from "../../lib/model-catalog";
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  RadioGroup,
  RadioGroupItem,
} from "../ui";

/* Disabled controls keep their concise native and accessible descriptions. */
const KEEPS_ITS_TOOLTIP = "disabled:pointer-events-auto disabled:cursor-default";

export type ComposerDelivery = "queue" | "steer";

export interface ComposerModelOption {
  value: string;
  label: string;
  description: string | null;
  resolvedModel?: string | undefined;
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
  /** Codex-only containment setting; Claude sessions render no control. */
  sandbox?: SandboxPolicy | null;
  providerOptions?: readonly CockpitProvider[];
  modelOptions?: readonly ComposerModelOption[];
  modelOptionsStatus?: string | null;
  modelChangeUnavailableReason?: string | null;
  effortChangeUnavailableReason?: string | null;
  profileChangeUnavailableReason?: string | null;
  sandboxChangeUnavailableReason?: string | null;
  effortOptions?: readonly NonNullable<SessionComposerProps["effort"]>[];
  profileOptions?: readonly ExecutionProfile[];
  settingsIdleOnly?: boolean;
  draft?: boolean;
  busy?: boolean;
  onProviderChange?: (provider: CockpitProvider) => void;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: NonNullable<SessionComposerProps["effort"]>) => void;
  onProfileChange?: (profile: ExecutionProfile) => void;
  onSandboxChange?: (sandbox: SandboxPolicy) => void;
  /** Present when a catalog that failed to load can be asked for again. */
  onReloadModels?: () => void;
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

const SANDBOX_LABEL: Record<CodexSandboxMode, string> = {
  "read-only": "Read-only",
  "workspace-write": "Workspace",
  "danger-full-access": "Danger: full access",
};

/*
  The sandbox is a second public setting, not a restatement of the profile: the
  profile says whether Codex asks before it acts, this says what acting can
  reach. Network access is only a question for workspace-write — read-only
  cannot reach it and full access always can.
*/
function sandboxLabel(sandbox: SandboxPolicy | null): string {
  if (sandbox === null) return "Sandbox unknown";
  const base = SANDBOX_LABEL[sandbox.mode];
  return sandbox.mode === "workspace-write" && sandbox.networkAccess ? `${base} · network` : base;
}

function effortLabel(effort: ReasoningEffort | null): string {
  if (effort === null) return "Unknown";
  if (effort === "xhigh") return "XHigh";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}

export function SessionComposer(props: SessionComposerProps) {
  const {
    value, onChange, onSend, onStop, isRunning, canQueue, canSteer, canStop,
    readOnlyReason, provider, model, effort, profile, providerOptions = ["codex", "claude"],
    modelOptions = [], modelOptionsStatus = null, effortOptions = [],
    modelChangeUnavailableReason = null, effortChangeUnavailableReason = null,
    profileChangeUnavailableReason = null, sandboxChangeUnavailableReason = null,
    profileOptions = ["ask-first", "plan", "execute", "full-access"],
    sandbox = null,
    settingsIdleOnly = false, draft = false, busy = false,
    onProviderChange, onModelChange, onEffortChange, onProfileChange, onSandboxChange,
    onReloadModels, onResetSettings, onSearchFiles,
  } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The only state the composer still keeps for its menus: which one is open.
  // Radix owns focus, dismissal, roving tabindex and positioning; this exists
  // solely so ⌘⇧M and M can drive the same menus the triggers do, and so the
  // two menus stay mutually exclusive.
  const [openMenu, setOpenMenu] = useState<"runtime" | "profile" | "sandbox" | null>(null);
  const settingsDisabled = !draft && settingsIdleOnly && isRunning;
  const runtimeHasAction = Boolean(onProviderChange || onModelChange || onEffortChange || onResetSettings || onReloadModels);
  // A catalog the harness will not let this cockpit write is still worth
  // reading. The menu opens with every choice disabled and the exact reason.
  const runtimeIsReadable = modelOptions.length > 0 || Boolean(modelOptionsStatus);
  const runtimeDisabled = settingsDisabled || (!runtimeHasAction && !runtimeIsReadable);
  const profileDisabled = settingsDisabled || !onProfileChange;
  // Claude has no sandbox at all, so it gets no control rather than a disabled
  // one: an unavailable setting and a nonexistent setting are different facts.
  const showSandbox = provider === "codex";
  const sandboxDisabled = settingsDisabled || !onSandboxChange;
  const runtimeDisabledReason = settingsDisabled
    ? "Available when this turn finishes"
    : modelChangeUnavailableReason ?? effortChangeUnavailableReason ?? "This harness does not expose live model or effort changes.";
  const profileDisabledReason = settingsDisabled
    ? "Available when this turn finishes"
    : profileChangeUnavailableReason ?? "This harness does not expose live execution-profile changes.";
  const sandboxDisabledReason = settingsDisabled
    ? "Available when this turn finishes"
    : sandboxChangeUnavailableReason ?? "This harness does not expose live sandbox changes.";
  /*
    The session states its model as a wire id; the catalog lists alias rows.
    The covering row — exact match, or the alias whose `resolvedModel` names
    the same wire id — is what the selector marks selected and reads efforts
    from.
  */
  const selectedOption = coveringModelOption(model, modelOptions);
  /*
    The provider's catalog in the selector's shape. Efforts hang off the model
    because that is where the component looks for them. Each model keeps its
    own declared levels; the selected-model list is only a compatibility seam
    when a caller has not copied those levels onto the selected option yet.
  */
  const selectorModels: ModelSelectorOption[] = modelOptions.map((option) => {
    const levels = option.efforts ?? (option === selectedOption ? effortOptions : []);
    return {
      id: option.value,
      name: option.label,
      // The id disambiguates two models with the same friendly name, so it
      // remains searchable and visible below the label.
      description: option.description ? `${option.value} · ${option.description}` : option.value,
      keywords: [option.value],
      ...(!onModelChange ? {
        disabled: true,
        ...(modelChangeUnavailableReason ? { disabledReason: modelChangeUnavailableReason } : {}),
      } : {}),
      ...(levels.length > 0
        ? { efforts: levels.map((level) => ({ id: level, name: effortLabel(level) })) }
        : {}),
    };
  });
  /*
    Levels to offer while nothing is selected — and only when nothing is
    chosen at all. A model that is named but absent from the catalog is
    unknown, not unspecified, and borrows no levels from rows that are not it.
  */
  const fallbackEfforts = model === null && effortOptions.length > 0
    ? effortOptions.map((level) => ({ id: level, name: effortLabel(level) }))
    : null;
  const sendDisabled = busy || value.trim().length === 0 || !canQueue;
  const effortIndex = effort === null ? -1 : effortOptions.indexOf(effort);
  const hasEffortScale = effortOptions.length > 0 && effortIndex >= 0;
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
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "s") {
        if (!showSandbox || sandboxDisabled) return;
        event.preventDefault();
        setOpenMenu((current) => current === "sandbox" ? null : "sandbox");
      } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === "." && isRunning && canStop) {
        event.preventDefault();
        void onStop?.();
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [canStop, isRunning, onStop, profileDisabled, runtimeDisabled, sandboxDisabled, showSandbox]);

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
    <div className="w-full min-w-0 max-w-full rounded-composer border border-[var(--border-hairline)] bg-[var(--surface-raised-hover)] px-3.5 pt-3.5 pb-2.5" data-session-composer>
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
        placeholder={readOnlyReason ? "" : isRunning ? "Queue a message…" : composerPlaceholder(provider, Boolean(onSearchFiles))}
      />
      <div className="composer-toolbar min-w-0 max-w-full" data-composer-toolbar>
        <div className="composer-toolbar__runtime">
        {/*
          assistant-ui's ModelSelector, composed rather than taken whole: its
          default export registers the selection into `ModelContext`, where it
          would ride on `config.modelName` in every chat request. A model change
          here is an explicit, capability-gated action against the harness, so
          that registration must not happen.

          The gate stays outside it: unavailable mutations retain concise
          native and accessible descriptions without adding another copy wall.
        */}
        {/*
          Always controlled: an unmatched or absent model must check no row,
          not fall back to the component's first-entry default.
        */}
        <ModelSelectorRoot
          models={selectorModels}
          value={selectedOption?.value ?? model ?? ""}
          onValueChange={(next) => onModelChange?.(next)}
          {...(effort ? { effort } : {})}
          {...(fallbackEfforts ? { fallbackEfforts } : {})}
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
            aria-description={runtimeDisabled ? runtimeDisabledReason : undefined}
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
            <ModelSelectorEffort
              disabled={!onEffortChange}
              {...(!onEffortChange && effortChangeUnavailableReason
                ? { disabledReason: effortChangeUnavailableReason }
                : {})}
            />
            {modelOptions.length === 0 && modelOptionsStatus && (
              <p className="px-2.5 py-1.5 text-code-sm text-[var(--text-muted)]" role="status">
                {modelOptionsStatus}
                {onReloadModels && (
                  <Button variant="ghost" size="sm" data-compact-control="height" className="ml-2 px-0 underline" onClick={() => onReloadModels()}>
                    Try again
                  </Button>
                )}
              </p>
            )}
            {/*
              A row the harness will not let this cockpit write is disabled, and
              a disabled row that says nothing is indistinguishable from a broken
              one. The reason belongs where it can be read, not only on hover.
            */}
            {modelOptions.length > 0 && !onModelChange && modelChangeUnavailableReason && (
              <p className="px-2.5 py-1.5 text-code-sm text-[var(--text-muted)]" role="status">{modelChangeUnavailableReason}</p>
            )}
            {onResetSettings && (
              <div className="border-t border-[var(--rule)] p-1">
                <Button variant="ghost" size="sm" data-compact-control="height" disabled={settingsDisabled} className="w-full justify-start gap-2 text-meta-sm text-[var(--text-muted)]" onClick={() => onResetSettings()}>
                  <RotateCcw size={12} aria-hidden="true" />Reset to configured defaults
                </Button>
              </div>
            )}
          </ModelSelectorContent>
        </ModelSelectorRoot>
          <span
            className="flex min-h-[17px] shrink-0 items-end gap-0.5 text-code-xs text-[var(--text-muted)]"
            role="img"
            aria-label={hasEffortScale ? `${effortLabel(effort)} effort, level ${effortIndex + 1} of ${effortOptions.length}` : `${effortLabel(effort)} effort`}
            data-effort-meter={hasEffortScale ? "scaled" : "word-only"}
          >
            {hasEffortScale ? effortOptions.map((option, index) => {
              const active = index <= effortIndex;
              return <span
                key={option}
                data-effort-bar={active ? "active" : "inactive"}
                data-effort-level={option}
                className={`w-[3px] ${active ? "bg-[var(--accent)]" : "bg-[var(--border-strong)]"}`}
                style={{ height: `${5 + index * 2}px` }}
              />;
            }) : <span data-effort-word>{effortLabel(effort)}</span>}
            {hasEffortScale && (effort === "max" || effort === "ultra") && <span className="ml-1" data-effort-word>{effortLabel(effort)}</span>}
          </span>
        </div>
        <div className="composer-toolbar__policies">
        <span className="composer-wide-separator h-3.5 w-px shrink-0 bg-[var(--border)]" />
        <DropdownMenu open={openMenu === "profile"} onOpenChange={(next) => setOpenMenu(next ? "profile" : null)}>
          <DropdownMenuTrigger asChild disabled={profileDisabled}>
            <Button
              variant="ghost"
              size="sm"
              data-compact-control
              className={`h-auto min-h-8 gap-1.5 rounded-full px-2 text-meta data-[state=open]:bg-[var(--surface-selected)] ${KEEPS_ITS_TOOLTIP}`}
              title={profileDisabled ? profileDisabledReason : undefined}
              aria-description={profileDisabled ? profileDisabledReason : undefined}
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
        {/*
          Full access used to be badged three times over — here, on the profile
          trigger above, and again as a drawer-header fact chip. Saying it once,
          orange, on the control that changes it is the whole point of an
          alarming colour; repeating it spends the alarm. The same rule governs
          the danger sandbox below: orange on the control that sets it, nowhere
          else.
        */}
        {showSandbox && (
          <>
            <span className="composer-wide-separator h-3.5 w-px shrink-0 bg-[var(--border)]" />
            <DropdownMenu open={openMenu === "sandbox"} onOpenChange={(next) => setOpenMenu(next ? "sandbox" : null)}>
              <DropdownMenuTrigger asChild disabled={sandboxDisabled}>
                <Button
                  variant="ghost"
                  size="sm"
                  data-compact-control
                  className={`h-auto min-h-8 gap-1.5 rounded-full px-2 text-meta data-[state=open]:bg-[var(--surface-selected)] ${KEEPS_ITS_TOOLTIP}`}
                  title={sandboxDisabled ? sandboxDisabledReason : undefined}
                  aria-description={sandboxDisabled ? sandboxDisabledReason : undefined}
                >
                  <span className={sandbox?.mode === "danger-full-access" ? "text-[var(--access)]" : "text-[var(--text-secondary)]"}>{sandboxLabel(sandbox)}</span>
                  <ChevronDown size={12} strokeWidth={1.75} className="text-[var(--text-faint)]" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" aria-labelledby={undefined} aria-label="Sandbox" className="min-w-52">
                <DropdownMenuRadioGroup
                  value={sandbox?.mode ?? ""}
                  onValueChange={(next) => onSandboxChange?.(
                    sandboxPolicy(next as CodexSandboxMode, sandbox?.networkAccess ?? false),
                  )}
                >
                  {CODEX_SANDBOX_MODES.map((mode) => (
                    <DropdownMenuRadioItem key={mode} value={mode} className={mode === "danger-full-access" ? "text-[var(--access)]" : ""}>
                      {SANDBOX_LABEL[mode]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={sandbox?.networkAccess ?? false}
                  disabled={sandbox?.mode !== "workspace-write"}
                  onCheckedChange={(checked) => onSandboxChange?.(sandboxPolicy("workspace-write", checked === true))}
                >
                  Network access
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        </div>
        <div className="composer-toolbar__actions">
        <span className="hidden shrink-0 font-mono text-code-sm whitespace-nowrap text-[var(--text-muted)] md:inline">{isRunning ? "queues while running" : "↵ sends"}</span>
        {/*
          A withheld capability, not decoration: it stays visible, disabled, and
          says why. Dictation used to sit beside it and was removed instead —
          spec 06 permits either treatment, and a control with no path forward
          is noise, where attachments are tracked work.
        */}
        <Button variant="ghost" size="icon" disabled aria-label="Attach files unavailable" title="Attachments are not supported yet — tracked in #6" className={`hidden size-8 text-[var(--text-faint)] sm:inline-flex ${KEEPS_ITS_TOOLTIP}`}><Paperclip size={16} strokeWidth={1.75} /></Button>
        {isRunning && canStop ? (
          <Button variant="ghost" size="icon" data-compact-control className="size-[30px] rounded-full bg-[var(--text)] text-[var(--app)] hover:bg-[var(--text-secondary)] hover:text-[var(--app)]" aria-label="Stop turn" onClick={() => void onStop?.()}><Square size={11} strokeWidth={2} /></Button>
        ) : (
          <Button variant="primary" size="icon" data-compact-control disabled={sendDisabled} className="size-[30px]" aria-label={isRunning ? "Queue message" : "Send message"} onClick={() => void send("queue")}><ArrowUp size={15} strokeWidth={2} /></Button>
        )}
        </div>
      </div>
    </div>
  );
}
