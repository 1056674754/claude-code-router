import { useEffect, useState } from "react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle, cn, Input, KeyRound, Label, LoaderCircle,
  Trash2, useAppErrorText, useAppText
} from "../shared/index";
import type { ClaudeAccountEntry, ClaudeSessionDetail, ClaudeSessionSummary } from "@ccr/core/contracts/app";

// EXPERIMENTAL Claude official-account management + session reader + direct
// usage import. Account switching moves credential material into the live
// ~/.claude slot — a MANUAL act, never automatic (prompt caches are
// per-account, mirroring the Codex pool rule).

export function ClaudeSettingsPage() {
  const t = useAppText();
  const formatError = useAppErrorText();
  const [accounts, setAccounts] = useState<ClaudeAccountEntry[]>([]);
  const [sessions, setSessions] = useState<ClaudeSessionSummary[]>([]);
  const [detail, setDetail] = useState<ClaudeSessionDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [usageById, setUsageById] = useState<Record<string, string>>({});
  const [importResult, setImportResult] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [copiedId, setCopiedId] = useState("");

  function reload() {
    setError("");
    void window.ccr?.listClaudeAccounts?.()
      .then(setAccounts)
      .catch((loadError) => setError(formatError(loadError)));
    void window.ccr?.listClaudeSessions?.()
      .then((items) => setSessions(items.slice(0, 50)))
      .catch(() => setSessions([]));
  }

  useEffect(() => {
    reload();
  }, []);

  async function run(action: () => Promise<void>, marker: string) {
    setBusy(marker);
    setError("");
    try {
      await action();
    } catch (runError) {
      setError(formatError(runError));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-4 overflow-y-auto p-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-[13px]">
            <KeyRound className="h-4 w-4" />
            {t("Claude accounts")}
            <Badge variant="warning">{t("Experimental")}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-[12px] leading-5 text-muted-foreground">
            {t("Each account owns its own credential slot. Switching moves the captured login into the live ~/.claude slot — manual only, never automatic, because prompt caches are per-account.")}
          </p>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Label className="text-[11px]">{t("Account label")}</Label>
              <Input
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("e.g. work / personal")}
                value={label}
              />
            </div>
            <Button
              disabled={busy === "capture"}
              onClick={() => void run(async () => {
                await window.ccr?.captureClaudeAccount?.({ label });
                setLabel("");
                reload();
              }, "capture")}
              type="button"
              variant="outline"
            >
              {busy === "capture" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
              {t("Capture current login")}
            </Button>
          </div>
          {accounts.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-3 text-center text-[12px] text-muted-foreground">
              {t("No captured accounts yet. Capture the current Claude Code login to create the first slot.")}
            </div>
          ) : (
            <div className="space-y-2">
              {accounts.map((account) => (
                <div className="rounded-md border border-border bg-background/60 px-3 py-2" key={account.id}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", account.isLive ? "bg-emerald-500" : account.status === "ready" ? "bg-muted-foreground/50" : "bg-red-400")} />
                    <span className="min-w-0 truncate text-[12px] font-medium">{account.label}</span>
                    {account.isLive ? <Badge variant="success">{t("In use")}</Badge> : null}
                    <span className="min-w-0 flex-1" />
                    {!account.isLive ? (
                      <Button
                        className="h-6 px-2 text-[11px]"
                        disabled={Boolean(busy)}
                        onClick={() => void run(async () => {
                          await window.ccr?.switchClaudeAccount?.({ id: account.id });
                          reload();
                        }, `switch-${account.id}`)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {t("Use")}
                      </Button>
                    ) : null}
                    <Button
                      className="h-6 px-2 text-[11px]"
                      disabled={Boolean(busy)}
                      onClick={() => void run(async () => {
                        const usage = await window.ccr?.getClaudeAccountUsage?.({ accountId: account.id });
                        setUsageById((current) => ({
                          ...current,
                          [account.id]: JSON.stringify(usage?.payload ?? {}, null, 2)
                        }));
                      }, `usage-${account.id}`)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {t("Usage")}
                    </Button>
                    <Button
                      aria-label={`${t("Remove")} ${account.label}`}
                      className="h-6 w-6"
                      disabled={Boolean(busy)}
                      onClick={() => void run(async () => {
                        await window.ccr?.removeClaudeAccount?.({ id: account.id });
                        reload();
                      }, `remove-${account.id}`)}
                      size="iconSm"
                      title={t("Remove")}
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {usageById[account.id] ? (
                    <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[10px] leading-4">{usageById[account.id]}</pre>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-[13px]">{t("Direct usage import")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-[12px] leading-5 text-muted-foreground">
            {t("Parse Claude Code session transcripts (~/.claude/projects) and count their token usage in the dashboard, so DIRECT-mode traffic is not invisible.")}
          </p>
          <Button
            disabled={importBusy}
            onClick={() => void run(async () => {
              setImportBusy(true);
              const result = await window.ccr?.importClaudeDirectUsage?.();
              setImportResult(`${result?.eventsImported ?? 0} imported · ${result?.tokensTotal ?? 0} tokens · ${result?.eventsSkippedExisting ?? 0} existing`);
              setImportBusy(false);
            }, "import")}
            type="button"
            variant="outline"
          >
            {importBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            {t("Import direct usage")}
          </Button>
          {importResult ? <div className="text-[12px] text-muted-foreground">{importResult}</div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-[13px]">{t("Claude sessions")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {sessions.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-3 text-center text-[12px] text-muted-foreground">
              {t("No recent sessions found in ~/.claude/projects.")}
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => (
                <div className="rounded-md border border-border bg-background/60 px-3 py-2" key={session.file}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium" title={session.title}>{session.title}</span>
                    <Badge variant="outline">{session.messageCount}</Badge>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{session.project}</span>
                    <Button
                      className="h-6 px-2 text-[11px]"
                      onClick={() => void run(async () => {
                        if (detail?.file === session.file) {
                          setDetail(undefined);
                          return;
                        }
                        setDetailLoading(true);
                        const sessionDetail = await window.ccr?.getClaudeSession?.({ file: session.file });
                        setDetail(sessionDetail);
                        setDetailLoading(false);
                      }, `view-${session.file}`)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {detailLoading && detail?.file === session.file ? <LoaderCircle className="h-3 w-3 animate-spin" /> : t("View")}
                    </Button>
                    <Button
                      className="h-6 px-2 text-[11px]"
                      onClick={() => {
                        void navigator.clipboard.writeText(`claude --resume ${session.sessionId}`);
                        setCopiedId(session.file);
                        window.setTimeout(() => setCopiedId(""), 1200);
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {copiedId === session.file ? t("Copied") : t("Resume cmd")}
                    </Button>
                    <Button
                      aria-label={t("Remove")}
                      className="h-6 w-6"
                      onClick={() => void run(async () => {
                        await window.ccr?.deleteClaudeSession?.({ file: session.file });
                        if (detail?.file === session.file) {
                          setDetail(undefined);
                        }
                        reload();
                      }, `delete-${session.file}`)}
                      size="iconSm"
                      title={t("Remove")}
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {detail?.file === session.file ? (
                    <div className="mt-2 max-h-72 space-y-2 overflow-y-auto rounded-md border border-border/50 bg-muted/20 p-2">
                      {detail.truncated ? (
                        <div className="px-1 text-[10px] text-muted-foreground">{t("Showing the most recent messages only.")}</div>
                      ) : null}
                      {detail.messages.map((message, messageIndex) => (
                        <div className="rounded-md bg-background/70 px-2 py-1.5" key={`${messageIndex}-${message.timestamp ?? ""}`}>
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <Badge variant={message.role === "user" ? "secondary" : "outline"}>{message.role}</Badge>
                            {message.hasThinking ? <Badge variant="outline">{t("thinking")}</Badge> : null}
                            {message.hasImage ? <Badge variant="outline">{t("image")}</Badge> : null}
                            {message.toolUses.length > 0 ? <span>{message.toolUses.map((toolUse) => toolUse.name).join(", ")}</span> : null}
                            {message.model ? <span className="truncate">{message.model}</span> : null}
                          </div>
                          {message.text ? (
                            <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[11px] leading-4">{message.text}</pre>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-600 dark:text-red-400">{error}</div>
      ) : null}
    </div>
  );
}
