import { Badge } from "../ui";
import { cn } from "../../lib/utils";
import type { BoardSession } from "./model";

export function SessionIdentityBadges({
  session,
  className,
}: {
  session: BoardSession;
  className?: string;
}) {
  return (
    <span
      className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
      data-session-identity
    >
      <Badge
        tone="outline"
        size="sm"
        aria-label={`Harness: ${session.harnessLabel}`}
        data-session-fact="harness"
      >
        <span className="text-[var(--text-faint)]">Harness</span>
        <span aria-hidden="true" className="text-[var(--text-faint)]">·</span>
        <span>{session.harnessLabel}</span>
      </Badge>
      <Badge
        tone="outline"
        size="sm"
        className="max-w-full min-w-0 overflow-hidden"
        aria-label={`Project: ${session.projectName}`}
        data-session-fact="project"
        title={session.projectName}
      >
        <span className="shrink-0 text-[var(--text-faint)]">Project</span>
        <span aria-hidden="true" className="shrink-0 text-[var(--text-faint)]">·</span>
        <span className="min-w-0 truncate">{session.projectName}</span>
      </Badge>
    </span>
  );
}
