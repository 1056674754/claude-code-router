import { isClaudeAppDesktopSafeModelId } from "@ccr/core/agents/claude-app/gateway-routes";
import type { ClaudeAppDesktopModelSlot } from "@ccr/core/contracts/app";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Button, CircleAlert, Field, Input, Plus, Toggle,
  useAppText, X
} from "../shared/index";

export type ClaudeAppDesktopModels = Array<ClaudeAppDesktopModelSlot | string>;

function normalizeSlot(slot: ClaudeAppDesktopModelSlot | string): ClaudeAppDesktopModelSlot {
  return typeof slot === "string" ? { name: slot } : slot;
}

/**
 * Editor for config.claudeAppDesktop.models — the slots written into the
 * Claude Desktop profile's inferenceModels on gateway apply. Declared slots
 * narrow the menu (empty/missing falls back to every routed model); unknown
 * names pass through and follow the Router rules at request time.
 */
export function ClaudeAppDesktopModelsSection({
  models,
  onChange
}: {
  models: ClaudeAppDesktopModels | undefined;
  onChange: (models: ClaudeAppDesktopModels | undefined) => void;
}) {
  const t = useAppText();
  const enabled = Array.isArray(models);
  const slots = (models ?? []).map(normalizeSlot);

  const updateSlot = (index: number, patch: Partial<ClaudeAppDesktopModelSlot>) => {
    if (!enabled) {
      return;
    }
    const next = slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot));
    onChange(next);
  };

  const moveSlot = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (!enabled || target < 0 || target >= slots.length) {
      return;
    }
    const next = [...slots];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const removeSlot = (index: number) => {
    if (!enabled) {
      return;
    }
    onChange(slots.filter((_, i) => i !== index));
  };

  return (
    <section className="mt-3 shrink-0 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">{t("Claude Desktop model slots")}</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {enabled
              ? t("Only the declared slots are written to the Claude Desktop menu. Unknown names follow the Router rules at request time.")
              : t("Every routed model is written to the Claude Desktop menu.")}
          </p>
        </div>
        <Toggle
          ariaLabel={t("Customize Claude Desktop menu")}
          checked={enabled}
          onChange={(checked) => onChange(checked ? (slots.length > 0 ? slots : [{ name: "" }]) : undefined)}
        />
      </div>
      {enabled ? (
        <div className="mt-3 space-y-2">
          {slots.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              {t("No slots declared — the menu falls back to every routed model.")}
            </p>
          ) : null}
          {slots.map((slot, index) => {
            const name = slot.name.trim();
            const unsafe = name.length > 0 && !isClaudeAppDesktopSafeModelId(name);
            return (
              <div className="rounded-md border border-border bg-background p-2" key={index}>
                <div className="flex min-w-0 flex-wrap items-end gap-2">
                  <Field className="min-w-0 flex-1" label={t("Slot name")}>
                    <Input
                      onChange={(event) => updateSlot(index, { name: event.target.value })}
                      placeholder="deepseek-v4.1-flash"
                      value={slot.name}
                    />
                  </Field>
                  <Field className="min-w-0 flex-1" label={t("Display label")}>
                    <Input
                      onChange={(event) => updateSlot(index, { label: event.target.value })}
                      placeholder={t("Optional")}
                      value={slot.label ?? ""}
                    />
                  </Field>
                  <label className="flex shrink-0 items-center gap-1.5 pb-2 text-[12px] text-muted-foreground">
                    <Checkbox
                      checked={slot.supports1m === true}
                      onCheckedChange={(checked) => updateSlot(index, { supports1m: checked || undefined })}
                    />
                    {t("1M context")}
                  </label>
                  <div className="flex shrink-0 items-center gap-1 pb-0.5">
                    <Button
                      aria-label={t("Move up")}
                      disabled={index === 0}
                      onClick={() => moveSlot(index, -1)}
                      size="iconSm"
                      type="button"
                      variant="ghost"
                    >
                      <span aria-hidden>↑</span>
                    </Button>
                    <Button
                      aria-label={t("Move down")}
                      disabled={index === slots.length - 1}
                      onClick={() => moveSlot(index, 1)}
                      size="iconSm"
                      type="button"
                      variant="ghost"
                    >
                      <span aria-hidden>↓</span>
                    </Button>
                    <Button
                      aria-label={t("Remove")}
                      onClick={() => removeSlot(index)}
                      size="iconSm"
                      type="button"
                      variant="ghost"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {unsafe ? (
                  <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-amber-700">
                    <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t("Claude Desktop may reject this name and fail the whole menu. Prefer a name an existing route matches, or a claude-sonnet-*/opus-*/haiku-*/fable-* style id.")}
                  </p>
                ) : null}
              </div>
            );
          })}
          <Button
            onClick={() => onChange([...slots, { name: "" }])}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("Add slot")}
          </Button>
        </div>
      ) : null}
      {enabled ? (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {t("Names matching a routed model reuse its route id (native claude-* names unlock Desktop's thinking/effort UI); empty rows are discarded on save.")}
        </p>
      ) : null}
    </section>
  );
}
