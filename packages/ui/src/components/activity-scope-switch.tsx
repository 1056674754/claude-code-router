import { ACTIVITY_SCOPES, type ActivityScope } from "@/lib/usage-activity";
import { cn } from "@/lib/utils";

const activityScopeLabelKeys: Record<ActivityScope, string> = {
  "30d": "30d",
  "7d": "7d",
  all: "All time"
};

const defaultContainerClassName = "flex shrink-0 items-center gap-0.5 rounded-full border border-border/50 bg-muted/40 p-0.5";
const defaultItemClassName = "rounded-full px-2 py-1 text-[9px] font-semibold leading-none transition-colors";
const defaultActiveItemClassName = "bg-foreground text-background shadow-sm";
const defaultInactiveItemClassName = "text-muted-foreground hover:text-foreground";

// One control for both surfaces. The tray passes the `tray-segmented` classes
// (and relies on `data-active`), the overview card keeps the shadcn tokens.
export function ActivityScopeSwitch({
  activeItemClassName,
  className,
  inactiveItemClassName,
  itemClassName,
  onChange,
  translate,
  value
}: {
  activeItemClassName?: string;
  className?: string;
  inactiveItemClassName?: string;
  itemClassName?: string;
  onChange: (scope: ActivityScope) => void;
  translate: (key: string) => string;
  value: ActivityScope;
}) {
  const containerClassName = className ?? defaultContainerClassName;
  const sharedItemClassName = itemClassName ?? defaultItemClassName;

  return (
    <div aria-label={translate("Statistics window")} className={containerClassName} role="group">
      {ACTIVITY_SCOPES.map((scope) => {
        const active = scope === value;
        const stateClassName = active
          ? activeItemClassName === undefined
            ? defaultActiveItemClassName
            : activeItemClassName
          : inactiveItemClassName === undefined
            ? defaultInactiveItemClassName
            : inactiveItemClassName;
        return (
          <button
            aria-pressed={active}
            className={cn(sharedItemClassName, stateClassName)}
            data-active={active}
            key={scope}
            onClick={() => onChange(scope)}
            type="button"
          >
            {translate(activityScopeLabelKeys[scope])}
          </button>
        );
      })}
    </div>
  );
}
