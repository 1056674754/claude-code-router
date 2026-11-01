import { isClaudeAppDesktopSafeModelId } from "@ccr/core/contracts/app";
import type { ClaudeAppDesktopModelSlot } from "@ccr/core/contracts/app";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Button, Card, CardContent, CardHeader, CardTitle, CircleAlert, Field, Input,
  Plus, Toggle, useAppText, X
} from "../shared/index";
import { useEffect, useRef, useState } from "react";

export type ClaudeAppDesktopModels = Array<ClaudeAppDesktopModelSlot | string>;

function normalizeSlot(slot: ClaudeAppDesktopModelSlot | string): ClaudeAppDesktopModelSlot {
  return typeof slot === "string" ? { name: slot } : slot;
}

function cleanRows(rows: ClaudeAppDesktopModelSlot[]): ClaudeAppDesktopModelSlot[] {
  return rows
    .map((slot) => ({
      name: slot.name.trim(),
      ...(slot.label?.trim() ? { label: slot.label.trim() } : {}),
      ...(slot.supports1m === true ? { supports1m: true as const } : {})
    }))
    .filter((slot) => slot.name.length > 0);
}

/**
 * Editor for config.claudeAppDesktop.models — the slots written into the
 * Claude Desktop profile's inferenceModels on gateway apply. Declared slots
 * narrow the menu (empty/missing falls back to every routed model); unknown
 * names pass through and follow the Router rules at request time.
 *
 * Row drafts live in local state and only cleaned (non-empty-name) rows are
 * propagated upward: the config save round-trip strips empty rows and the
 * reconciliation pushes the saved config back into the draft, so rows handed
 * straight to config would be reclaimed mid-edit.
 */
export function ClaudeAppDesktopModelsCard({
  models,
  onChange
}: {
  models: ClaudeAppDesktopModels | undefined;
  onChange: (models: ClaudeAppDesktopModels | undefined) => void;
}) {
  const t = useAppText();
  const [customized, setCustomized] = useState(() => Array.isArray(models));
  const [rows, setRows] = useState<ClaudeAppDesktopModelSlot[]>(() => (models ?? []).map(normalizeSlot));
  const lastPropagated = useRef<string | undefined>(undefined);

  // Adopt external config changes (another editor, another device) but skip
  // echoes of what this editor just propagated — those arrive with empty rows
  // stripped and would otherwise clobber the row being typed.
  useEffect(() => {
    const propsKey = JSON.stringify((models ?? []).map(normalizeSlot));
    if (lastPropagated.current === undefined || lastPropagated.current !== propsKey) {
      lastPropagated.current = propsKey;
      setRows((models ?? []).map(normalizeSlot));
      setCustomized(Array.isArray(models));
    }
  }, [models]);

  const updateRows = (next: ClaudeAppDesktopModelSlot[]) => {
    setRows(next);
    const cleaned = cleanRows(next);
    lastPropagated.current = JSON.stringify(cleaned);
    onChange(customized && cleaned.length > 0 ? cleaned : undefined);
  };

  const updateSlot = (index: number, patch: Partial<ClaudeAppDesktopModelSlot>) => {
    updateRows(rows.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)));
  };

  const moveSlot = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rows.length) {
      return;
    }
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    updateRows(next);
  };

  const removeSlot = (index: number) => {
    updateRows(rows.filter((_, i) => i !== index));
  };

  const toggleCustomized = (checked: boolean) => {
    setCustomized(checked);
    if (checked) {
      if (rows.length === 0) {
        setRows([{ name: "" }]);
      }
      return;
    }
    lastPropagated.current = "[]";
    onChange(undefined);
  };

  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{t("Claude Desktop model slots")}</CardTitle>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {customized
                ? t("Only the declared slots are written to the Claude Desktop menu. Unknown names follow the Router rules at request time.")
                : t("Every routed model is written to the Claude Desktop menu.")}
            </p>
          </div>
          <Toggle
            ariaLabel={t("Customize Claude Desktop menu")}
            checked={customized}
            onChange={toggleCustomized}
          />
        </div>
      </CardHeader>
      {customized ? (
        <CardContent className="max-h-[45vh] space-y-2 overflow-auto">
          {rows.map((slot, index) => {
            const name = slot.name.trim();
            const unsafe = name.length > 0 && !isClaudeAppDesktopSafeModelId(name);
            return (
              <div className="rounded-md border border-border bg-muted/20 p-2" key={index}>
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
                      disabled={index === rows.length - 1}
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
            onClick={() => updateRows([...rows, { name: "" }])}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("Add slot")}
          </Button>
          <p className="text-[12px] text-muted-foreground">
            {t("Names matching a routed model reuse its route id (native claude-* names unlock Desktop's thinking/effort UI); empty rows are discarded on save.")}
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}
