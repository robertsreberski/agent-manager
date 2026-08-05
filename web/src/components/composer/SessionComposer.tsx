import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, CodeXml, Mic, Paperclip, RotateCcw, Shield, Square } from "lucide-react";
import type { ReasoningEffort } from "@shared/session";
import type { CockpitProvider, ExecutionProfile } from "../../lib/cockpit-view";
import { isTypingTarget } from "../../lib/shortcuts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
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
  const sendDisabled = busy || value.trim().length === 0 || !canQueue;
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(120, Math.max(52, element.scrollHeight))}px`;
  }, [value]);
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
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={keyDown}
        disabled={Boolean(readOnlyReason) || busy}
        className="block min-h-[52px] max-h-[120px] w-full resize-none overflow-y-auto border-0 bg-transparent px-0.5 pt-0 pb-2.5 text-body text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
        aria-label="Message"
        placeholder={readOnlyReason ? "This session is read-only" : isRunning ? "Queue a message…" : "Message the agent…"}
      />
      <div className="flex min-w-0 items-center gap-2.5 sm:gap-3.5">
        <DropdownMenu open={openMenu === "runtime"} onOpenChange={(next) => setOpenMenu(next ? "runtime" : null)}>
          <DropdownMenuTrigger asChild disabled={runtimeDisabled}>
            <Button
              variant="ghost"
              size="sm"
              data-compact-control
              className={`h-auto min-h-8 min-w-0 justify-start rounded-full px-1.5 text-left text-meta data-[state=open]:bg-[var(--surface-selected)] sm:px-2 ${KEEPS_ITS_TOOLTIP}`}
              title={runtimeDisabled ? runtimeDisabledReason : undefined}
            >
              {/* Frame 5a fills this tile lime. Spec 12 R3 reserves lime for wants-you and
                  the operator's own primary action, so the tile keeps the frame's glyph and
                  a neutral fill — see the "provider identity and effort neutral" test. */}
              <span className="grid size-[17px] shrink-0 place-items-center bg-[var(--surface-selected-active)] text-[var(--text-muted)]" data-provider-mark>
                <CodeXml size={11} strokeWidth={2} />
              </span>
              <span className="shrink-0 font-medium capitalize">{provider}</span>
              {model && <span className="hidden min-w-0 max-w-28 truncate text-[var(--text-muted)] sm:inline">{model}</span>}
            </Button>
          </DropdownMenuTrigger>
          {/* Radix names a menu after its trigger; "codex gpt-5" is a worse
              label for this menu than what it actually contains. */}
          <DropdownMenuContent side="top" align="start" aria-labelledby={undefined} aria-label="Harness, model, and effort" className="max-w-[22rem] min-w-64">
            {draft && providerOptions.length > 0 && (
              <>
                <DropdownMenuRadioGroup value={provider} onValueChange={(next) => onProviderChange?.(next as CockpitProvider)}>
                  {providerOptions.map((option) => (
                    <DropdownMenuRadioItem key={option} value={option} disabled={!onProviderChange} className="capitalize">{option}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuRadioGroup value={model ?? ""} onValueChange={(next) => onModelChange?.(next)}>
              {modelOptions.map((option) => (
                <DropdownMenuRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={settingsDisabled || !onModelChange}
                  title={!onModelChange ? modelChangeUnavailableReason ?? undefined : undefined}
                  className="flex-col items-start gap-0.5 py-2"
                >
                  <span className="font-medium">{option.label}</span>
                  <span className="font-mono text-code-xs text-[var(--text-muted)]">{option.value}</span>
                  {option.description && <span className="text-code-xs text-[var(--text-faint)]">{option.description}</span>}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {modelOptions.length === 0 && modelOptionsStatus && <p className="px-2.5 py-1.5 text-code-sm text-[var(--text-muted)]" role="status">{modelOptionsStatus}</p>}
            {!onModelChange && modelChangeUnavailableReason && <p className="px-2.5 py-1.5 text-code-sm text-[var(--text-muted)]">{modelChangeUnavailableReason}</p>}
            {/* No rule unless the model section actually said something. */}
            {(modelOptions.length > 0 || modelOptionsStatus || (!onModelChange && modelChangeUnavailableReason)) && <DropdownMenuSeparator />}
            <DropdownMenuRadioGroup value={effort ?? ""} onValueChange={(next) => onEffortChange?.(next as NonNullable<SessionComposerProps["effort"]>)}>
              {effortOptions.map((option) => (
                <DropdownMenuRadioItem
                  key={option}
                  value={option}
                  disabled={settingsDisabled || !onEffortChange}
                  title={!onEffortChange ? effortChangeUnavailableReason ?? undefined : undefined}
                  className="capitalize"
                >{option} effort</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {!onEffortChange && effortChangeUnavailableReason && <p className="px-2.5 py-1.5 text-code-sm text-[var(--text-muted)]">{effortChangeUnavailableReason}</p>}
            {onResetSettings && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={settingsDisabled} className="text-[var(--text-muted)]" onSelect={() => onResetSettings()}>
                  <RotateCcw size={12} aria-hidden="true" />Reset to configured defaults
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="flex shrink-0 items-end gap-0.5" role="img" aria-label={`${effort ?? "unknown"} effort`}>
          {[1, 2, 3].map((bar) => <span key={bar} data-effort-bar={bar <= effortBars(effort) ? "active" : "inactive"} className={`w-[3px] ${bar <= effortBars(effort) ? "h-[11px] bg-[var(--text-muted)]" : "h-[7px] bg-[var(--border-strong)]"}`} />)}
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
        <span className="hidden shrink-0 font-mono text-code-sm whitespace-nowrap text-[var(--text-faint)] md:inline">{isRunning ? "queues while running" : "↵ sends"}</span>
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
