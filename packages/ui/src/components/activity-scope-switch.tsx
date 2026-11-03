import { ACTIVITY_SCOPES, type ActivityScope } from "@/lib/usage-activity";
import { cn } from "@/lib/utils";

const activityScopeLabelKeys: Record<ActivityScope, string> = {
  "30d": "30d",
  "7d": "7d",
  all: "All time"
};

const defaultContainerClassName = "flex shrink-0 items-center gap-0.5 rounded-full border border-border/50 bg-muted/40 p-0.5";
const defaultItemClassName = "rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none transition-colors";
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
  return (
    <div aria-label={translate("Statistics window")} className={cn(className ?? defaultContainerClassName)} role="group">
      {ACTIVITY_SCOPES.map((scope) => {
        const active = scope === value;
        return (
          <button
            aria-pressed={active}
            className={cn(itemClassName ?? defaultItemClassName, active ? activeItemClassName ?? defaultActiveItemClassName : inactiveItemClassName ?? defaultInactiveItemClassName)}
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
