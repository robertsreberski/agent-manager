import {
  AlertTriangle,
  Circle,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  ShieldAlert,
} from "lucide-react";
import { Badge, type BadgeProps } from "./ui/badge";
import type { Activity, ModeValue, Provider, SessionView } from "../types";

const ACTIVITY: Record<Activity, { label: string; variant: BadgeProps["variant"]; icon: typeof Circle }> = {
  running: { label: "Running", variant: "success", icon: CircleDashed },
  waiting: { label: "Waiting", variant: "warning", icon: CirclePause },
  idle: { label: "Idle", variant: "outline", icon: Circle },
  completed: { label: "Completed", variant: "secondary", icon: CircleCheck },
  failed: { label: "Failed", variant: "danger", icon: CircleX },
  interrupted: { label: "Interrupted", variant: "warning", icon: CirclePause },
  unknown: { label: "Unknown", variant: "outline", icon: Circle },
};

export function ActivityBadge({ activity, compact = false }: { activity: Activity; compact?: boolean }) {
  const config = ACTIVITY[activity];
  const Icon = config.icon;
  return (
    <Badge variant={config.variant} title={`Activity: ${config.label}`}>
      <Icon className="size-3" aria-hidden="true" />
      {!compact && config.label}
    </Badge>
  );
}

export function ModeBadge({ mode }: { mode: ModeValue }) {
  const label = mode === "planning" ? "Plan" : mode === "execution" ? "Execute" : "Mode unknown";
  return <Badge variant={mode === "planning" ? "info" : "outline"}>{label}</Badge>;
}

export function ProviderBadge({ provider }: { provider: Provider }) {
  return (
    <Badge variant="secondary" className="font-mono uppercase tracking-wide">
      {provider}
    </Badge>
  );
}

export function OwnershipBadge({ ownership }: { ownership: SessionView["ownership"] }) {
  return (
    <Badge variant={ownership === "manager" ? "info" : "outline"}>
      {ownership === "manager" ? "Manager" : "External"}
    </Badge>
  );
}

export function AttentionBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Badge variant="warning">
      <AlertTriangle className="size-3" aria-hidden="true" />
      {count} need{count === 1 ? "s" : ""} you
    </Badge>
  );
}

export function AccessBadge({ accessMode }: { accessMode: SessionView["effectiveAccess"]["accessMode"] }) {
  if (accessMode === "bypass-permissions") {
    return (
      <Badge variant="danger">
        <ShieldAlert className="size-3" aria-hidden="true" />
        Bypass permissions
      </Badge>
    );
  }
  return (
    <Badge variant={accessMode === "sandboxed" ? "secondary" : "outline"}>
      {accessMode === "sandboxed" ? "Sandboxed" : "Access unknown"}
    </Badge>
  );
}
