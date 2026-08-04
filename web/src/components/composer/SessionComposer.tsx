import { useEffect, useRef, useState } from "react";
import { ChevronDown, Mic, Paperclip, RotateCcw, Send, Shield, Square } from "lucide-react";
import type { ReasoningEffort } from "@shared/session";
import type { CockpitProvider, ExecutionProfile } from "../../lib/cockpit-view";
import { isTypingTarget } from "../../lib/shortcuts";

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
  const runtimeTriggerRef = useRef<HTMLButtonElement>(null);
  const profileTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<"runtime" | "profile" | null>(null);
  const settingsDisabled = !draft && settingsIdleOnly && isRunning;
  const runtimeHasAction = Boolean(onProviderChange || onModelChange || onEffortChange || onResetSettings);
  const runtimeDisabled = settingsDisabled || !runtimeHasAction;
  const profileDisabled = settingsDisabled || !onProfileChange;
  const runtimeDisabledReason = settingsDisabled
    ? "Available when this turn finishes"
    : modelChangeUnavailableReason ?? effortChangeUnavailableReason ?? "This harness does not expose live model or effort changes.";
  const profileDisabledReason = settingsDisabled
    ? "Available when this turn finishes"
    : profileChangeUnavailableReason ?? "This harness does not expose live execution-profile changes.";
  const sendDisabled = busy || value.trim().length === 0 || !canQueue;
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(120, Math.max(52, element.scrollHeight))}px`;
  }, [value]);
  useEffect(() => {
    if (menu === null) return;
    const first = menuRef.current?.querySelector<HTMLElement>("button:not(:disabled), [tabindex='0']");
    (first ?? menuRef.current)?.focus();
  }, [menu]);
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
        setMenu((current) => current === "runtime" ? null : "runtime");
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "m") {
        if (profileDisabled) return;
        event.preventDefault();
        setMenu((current) => current === "profile" ? null : "profile");
      } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === "." && isRunning && canStop) {
        event.preventDefault();
        void onStop?.();
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [canStop, isRunning, onStop, profileDisabled, runtimeDisabled]);

  function composerKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || menu === null) return;
    const trigger = menu === "runtime" ? runtimeTriggerRef.current : profileTriggerRef.current;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    setMenu(null);
    trigger?.focus();
  }

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
    <div className="relative rounded-2xl border border-[var(--border)] bg-[var(--surface-raised)] p-3.5" data-session-composer onKeyDownCapture={composerKeyDown}>
      {readOnlyReason && (
        <p className="mb-2 text-[12.5px] leading-5 text-[var(--text-muted)]" role="status">{readOnlyReason}</p>
      )}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={keyDown}
        disabled={Boolean(readOnlyReason) || busy}
        className="block min-h-[52px] max-h-[120px] w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-[15px] leading-[22px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
        aria-label="Message"
        placeholder={readOnlyReason ? "This session is read-only" : isRunning ? "Queue a message…" : "Message the agent…"}
      />
      <div className="mt-2 flex min-w-0 items-center gap-2 sm:gap-3.5">
        <button
          ref={runtimeTriggerRef}
          type="button"
          data-compact-control
          disabled={runtimeDisabled}
          className="flex min-h-8 min-w-0 items-center gap-1.5 rounded-full px-1.5 text-left text-[13px] data-[open=true]:bg-[var(--surface-selected)] sm:px-2"
          data-open={menu === "runtime"}
          aria-haspopup="menu"
          aria-expanded={menu === "runtime"}
          title={runtimeDisabled ? runtimeDisabledReason : undefined}
          onClick={() => setMenu((current) => current === "runtime" ? null : "runtime")}
        >
          <span className="grid size-[17px] shrink-0 place-items-center bg-[var(--surface-selected-active)] font-mono text-[9px] font-semibold uppercase text-[var(--text-muted)]" data-provider-mark>
            {provider.slice(0, 1)}
          </span>
          <span className="truncate font-medium capitalize">{provider}</span>
          {model && <span className="hidden max-w-28 truncate text-[var(--text-muted)] sm:inline">{model}</span>}
          <span className="flex items-end gap-0.5" aria-label={`${effort ?? "unknown"} effort`}>
            {[1, 2, 3].map((bar) => <span key={bar} data-effort-bar={bar <= effortBars(effort) ? "active" : "inactive"} className={`w-[3px] ${bar <= effortBars(effort) ? "h-[11px] bg-[var(--text-muted)]" : "h-[7px] bg-[var(--text-faint)]"}`} />)}
          </span>
          <ChevronDown size={12} strokeWidth={1.75} />
        </button>
        <span className="h-3.5 w-px shrink-0 bg-[var(--border)]" />
        <button
          ref={profileTriggerRef}
          type="button"
          data-compact-control
          disabled={profileDisabled}
          className="flex min-h-8 items-center gap-1 rounded-full px-2 text-[13px] data-[open=true]:bg-[var(--surface-selected)] disabled:opacity-45"
          data-open={menu === "profile"}
          aria-haspopup="menu"
          aria-expanded={menu === "profile"}
          title={profileDisabled ? profileDisabledReason : undefined}
          onClick={() => setMenu((current) => current === "profile" ? null : "profile")}
        >
          <span className={profile === "full-access" ? "text-[var(--access)]" : ""}>{profileLabel(profile)}</span>
          <ChevronDown size={12} strokeWidth={1.75} />
        </button>
        {profile === "full-access" && (
          <span className="hidden items-center gap-1 bg-[var(--access-field)] px-2 py-1 text-[11px] text-[var(--access)] sm:flex"><Shield size={11} />Full access</span>
        )}
        <span className="flex-1" />
        <span className="hidden font-mono text-[10px] text-[var(--text-faint)] md:inline">{isRunning ? "queues while running" : "↵ sends"}</span>
        <button type="button" disabled aria-label="Attach files unavailable" title="Attachments are not supported by this harness" className="hidden size-8 place-items-center text-[var(--text-faint)] disabled:opacity-40 sm:grid"><Paperclip size={16} strokeWidth={1.75} /></button>
        <button type="button" disabled aria-label="Dictation unavailable" title="Dictation is not configured" className="hidden size-8 place-items-center text-[var(--text-faint)] disabled:opacity-40 sm:grid"><Mic size={16} strokeWidth={1.75} /></button>
        {isRunning && canStop ? (
          <button type="button" data-compact-control className="grid size-[30px] shrink-0 place-items-center rounded-full bg-[var(--text)] text-[var(--app)]" aria-label="Stop turn" onClick={() => void onStop?.()}><Square size={11} fill="currentColor" /></button>
        ) : (
          <button type="button" data-compact-control disabled={sendDisabled} className="grid size-[30px] shrink-0 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] disabled:opacity-35" aria-label={isRunning ? "Queue message" : "Send message"} onClick={() => void send("queue")}><Send size={14} strokeWidth={2} /></button>
        )}
      </div>
      {menu === "runtime" && (
        <div ref={menuRef} tabIndex={-1} role="menu" aria-label="Harness, model, and effort" className="absolute bottom-[54px] left-3 z-20 grid min-w-64 gap-px border border-[var(--border)] bg-[var(--menu)] p-1 shadow-[0_24px_60px_rgb(0_0_0/0.65)]">
          {draft && providerOptions.map((option) => <button key={option} role="menuitemradio" aria-checked={provider === option} disabled={!onProviderChange} className="px-3 py-2 text-left text-[12.5px] capitalize hover:bg-[var(--surface-selected)] disabled:opacity-45" onClick={() => onProviderChange?.(option)}>{option}</button>)}
          {modelOptions.map((option) => <button key={option.value} role="menuitemradio" aria-checked={model === option.value} disabled={settingsDisabled || !onModelChange} title={!onModelChange ? modelChangeUnavailableReason ?? undefined : undefined} className="px-3 py-2 text-left hover:bg-[var(--surface-selected)] disabled:opacity-45" onClick={() => { if (!onModelChange) return; onModelChange(option.value); setMenu(null); }}><span className="block text-[12px] font-medium">{option.label}</span><span className="block font-mono text-[10.5px] text-[var(--text-muted)]">{option.value}</span>{option.description && <span className="mt-0.5 block max-w-72 text-[10.5px] leading-4 text-[var(--text-faint)]">{option.description}</span>}</button>)}
          {modelOptions.length === 0 && modelOptionsStatus && <p className="px-3 py-2 text-[11.5px] leading-4 text-[var(--text-muted)]" role="status">{modelOptionsStatus}</p>}
          {!onModelChange && modelChangeUnavailableReason && <p className="px-3 py-2 text-[11.5px] leading-4 text-[var(--text-muted)]">{modelChangeUnavailableReason}</p>}
          <div className="h-px bg-[var(--rule)]" />
          {effortOptions.map((option) => <button key={option} role="menuitemradio" aria-checked={effort === option} disabled={settingsDisabled || !onEffortChange} title={!onEffortChange ? effortChangeUnavailableReason ?? undefined : undefined} className="px-3 py-2 text-left text-[12.5px] capitalize hover:bg-[var(--surface-selected)] disabled:opacity-45" onClick={() => onEffortChange?.(option)}>{option} effort</button>)}
          {!onEffortChange && effortChangeUnavailableReason && <p className="px-3 py-2 text-[11.5px] leading-4 text-[var(--text-muted)]">{effortChangeUnavailableReason}</p>}
          {onResetSettings && <><div className="h-px bg-[var(--rule)]" /><button type="button" role="menuitem" disabled={settingsDisabled} className="flex min-h-9 items-center gap-2 px-3 text-left text-[12.5px] text-[var(--text-muted)] hover:bg-[var(--surface-selected)] disabled:opacity-45" onClick={() => { onResetSettings(); setMenu(null); }}><RotateCcw size={12} />Reset to configured defaults</button></>}
        </div>
      )}
      {menu === "profile" && (
        <div ref={menuRef} tabIndex={-1} role="menu" aria-label="Execution profile" className="absolute bottom-[54px] left-28 z-20 grid min-w-48 gap-px border border-[var(--border)] bg-[var(--menu)] p-1 shadow-[0_24px_60px_rgb(0_0_0/0.65)]">
          {profileOptions.map((option, index) => (
            <button key={option} role="menuitemradio" aria-checked={profile === option} className={`flex justify-between px-3 py-2 text-left text-[12.5px] hover:bg-[var(--surface-selected)] ${option === "full-access" ? "text-[var(--access)]" : ""}`} onClick={() => { onProfileChange?.(option); setMenu(null); }}>
              <span>{PROFILE_LABEL[option]}</span><kbd className="font-mono text-[10px] text-[var(--text-faint)]">{index + 1}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
