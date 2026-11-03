import { cn } from "@/lib/utils";
import { TooltipPortal } from "@/components/ui/tooltip";
import { buildActivityAxisMonthLabels, cellAtOffset, type TokenActivityCell } from "@/lib/usage-activity";
import { useElementSize } from "@/lib/use-element-size";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// Keeps the sizing math in sync with the month label row's `mb-1` class.
const MONTH_LABEL_BOTTOM_MARGIN = 4;

export type ActivityHeatmapTheme = {
  colorFor: (cell: TokenActivityCell) => string;
  dayLabels: string[];
  detailClassName?: string;
  labelClassName: string;
  labelColumnWidth: number;
  monthLabelClassName: string;
  paddingColor: string;
  tooltipContentClassName?: string;
};

export type ActivityHeatmapProps = {
  activity: {
    cells: TokenActivityCell[];
    weekCount: number;
  };
  ariaLabel: string;
  cellGap: number;
  className?: string;
  fallbackCellSize?: number;
  maxCellSize?: number;
  minCellSize?: number;
  showDayLabels?: boolean;
  showMonthLabels?: boolean;
  theme: ActivityHeatmapTheme;
  tokenCount: (value: number) => string;
  tokensLabel: string;
};

/**
 * Contribution-style activity calendar. Cells are painted on a single canvas so
 * a year (or three) of history costs one DOM node instead of thousands, and the
 * grid is always laid out edge to edge: "today" is pinned to the right edge, a
 * short history is padded with quiet squares on the left, and a long one is
 * clipped behind the fade mask on that same edge.
 */
export function ActivityHeatmap({
  activity,
  ariaLabel,
  cellGap,
  className,
  fallbackCellSize = 10,
  maxCellSize = 16,
  minCellSize = 6,
  showDayLabels = true,
  showMonthLabels = true,
  theme,
  tokenCount,
  tokensLabel
}: ActivityHeatmapProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const frameSize = useElementSize(frameRef);
  const monthLabelRef = useRef<HTMLDivElement>(null);
  const monthLabelSize = useElementSize(monthLabelRef, showMonthLabels);
  const monthLabelHeight = monthLabelSize.height || 14;
  const monthLabelBlockHeight = showMonthLabels ? monthLabelHeight + MONTH_LABEL_BOTTOM_MARGIN : 0;
  const measured = frameSize.width > 0;

  // Cell size comes from the height alone: narrowing the window reveals fewer
  // weeks instead of squashing the squares.
  const heightForCells = frameSize.height - monthLabelBlockHeight - 6 * cellGap;
  const cellSize = frameSize.height > 0 && heightForCells > 0
    ? Math.max(minCellSize, Math.min(maxCellSize, Math.floor(heightForCells / 7)))
    : fallbackCellSize;
  const weekStep = cellSize + cellGap;
  const availableWidth = Math.max(0, frameSize.width - (showDayLabels ? theme.labelColumnWidth + cellGap : 0));
  // Round down so a full column is never sliced in half by the right edge.
  const fitColumns = availableWidth > 0
    ? Math.max(1, Math.floor((availableWidth + cellGap) / weekStep))
    : Math.max(1, activity.weekCount);
  const overflowing = activity.weekCount > fitColumns;
  const overscan = overflowing ? 2 : 0;
  const totalColumns = overflowing ? fitColumns + overscan : Math.max(fitColumns, activity.weekCount);
  const startWeek = overflowing ? Math.max(0, activity.weekCount - totalColumns) : 0;
  const padColumns = Math.max(0, totalColumns - (activity.weekCount - startWeek));
  const gridWidth = totalColumns * cellSize + Math.max(0, totalColumns - 1) * cellGap;
  const gridHeight = cellSize * 7 + 6 * cellGap;

  const lastCellDate = activity.cells[activity.cells.length - 1]?.date;
  const monthLabels = lastCellDate
    ? buildActivityAxisMonthLabels({ columns: totalColumns, gridWidth, lastDate: lastCellDate, weekStep })
    : [];

  const cellsByPosition = useMemo(() => {
    const map = new Map<string, TokenActivityCell>();
    for (const cell of activity.cells) {
      map.set(`${cell.weekIndex}:${cell.dayIndex}`, cell);
    }
    return map;
  }, [activity.cells]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Only the grid position is state: label, value and pixel position are
  // derived on render, so a repaint from fresh data cannot leave stale numbers
  // inside an already open tooltip.
  const [hovered, setHovered] = useState<{ column: number; key: string; row: number }>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || gridWidth <= 0 || gridHeight <= 0) {
      return;
    }
    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.round(gridWidth * ratio);
    const height = Math.round(gridHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, gridWidth, gridHeight);
    const radius = Math.max(1.5, Math.min(3, cellSize * 0.22));
    const rounded = typeof context.roundRect === "function";
    const paint = (x: number, y: number, fill: string, scale = 1) => {
      const size = cellSize * scale;
      const offset = (cellSize - size) / 2;
      context.beginPath();
      if (rounded) {
        context.roundRect(x + offset, y + offset, size, size, radius);
      } else {
        context.rect(x + offset, y + offset, size, size);
      }
      context.fillStyle = fill;
      context.fill();
    };
    for (let column = 0; column < padColumns; column += 1) {
      for (let row = 0; row < 7; row += 1) {
        paint(column * weekStep, row * weekStep, theme.paddingColor);
      }
    }
    for (const cell of activity.cells) {
      if (cell.weekIndex < startWeek) {
        continue;
      }
      const column = padColumns + (cell.weekIndex - startWeek);
      if (column < 0 || column >= totalColumns) {
        continue;
      }
      const isHovered = hovered?.key === cell.dateKey;
      paint(column * weekStep, cell.dayIndex * weekStep, theme.colorFor(cell), isHovered ? 1.16 : 1);
      if (isHovered) {
        context.strokeStyle = "rgba(255,255,255,.6)";
        context.lineWidth = 1;
        context.stroke();
      }
    }
  }, [activity.cells, cellSize, gridHeight, gridWidth, hovered, padColumns, startWeek, theme, totalColumns, weekStep]);

  const handleCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const { column, onCell, row } = cellAtOffset(event.clientX - rect.left, event.clientY - rect.top, weekStep, cellSize);
    const cell = onCell && column >= padColumns
      ? cellsByPosition.get(`${startWeek + (column - padColumns)}:${row}`)
      : undefined;
    if (!cell) {
      if (hovered) {
        setHovered(undefined);
      }
      return;
    }
    if (cell.dateKey !== hovered?.key) {
      setHovered({ column, key: cell.dateKey, row });
    }
  };

  const hoveredCell = hovered
    ? cellsByPosition.get(`${startWeek + (hovered.column - padColumns)}:${hovered.row}`)
    : undefined;
  const canvasRect = hoveredCell ? canvasRef.current?.getBoundingClientRect() : undefined;
  const tooltipPosition = canvasRect && hovered
    ? (() => {
        const cellTop = canvasRect.top + hovered.row * weekStep;
        const below = cellTop < 64;
        const half = 90;
        const left = canvasRect.left + hovered.column * weekStep + cellSize / 2;
        return {
          below,
          left: Math.min(Math.max(left, half + 12), (window.innerWidth || 0) - half - 12),
          top: below ? cellTop + cellSize + 8 : cellTop - 8
        };
      })()
    : undefined;

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", className)} ref={frameRef}>
      {showDayLabels ? (
        <div
          className="flex shrink-0 flex-col"
          style={{ gap: cellGap, marginTop: monthLabelBlockHeight, width: theme.labelColumnWidth }}
        >
          {theme.dayLabels.map((label, index) => (
            <span
              className={cn("self-center truncate", theme.labelClassName)}
              key={`${label}-${index}`}
              style={{ height: cellSize, lineHeight: `${cellSize}px` }}
            >
              {label}
            </span>
          ))}
        </div>
      ) : null}
      <div
        className="relative flex min-w-0 flex-1 justify-end overflow-hidden"
        // Only a truly clipped history gets the fade; otherwise the leftmost
        // real week would be dimmed for no reason.
        style={overflowing ? {
          maskImage: "linear-gradient(to right, transparent 0px, black 24px)",
          WebkitMaskImage: "linear-gradient(to right, transparent 0px, black 24px)"
        } : undefined}
      >
        <div
          className="relative shrink-0"
          style={{ height: `${gridHeight + monthLabelBlockHeight}px`, width: `${gridWidth}px` }}
        >
          {showMonthLabels ? (
            <div
              className={cn("relative mb-1 whitespace-nowrap", theme.monthLabelClassName)}
              ref={monthLabelRef}
              style={{ height: monthLabelHeight }}
            >
              {monthLabels.map((month) => (
                <span
                  className="absolute whitespace-nowrap"
                  key={month.key}
                  style={{ left: `${month.left}px`, top: 0 }}
                >
                  {month.label}
                </span>
              ))}
            </div>
          ) : null}
          {measured ? (
            <canvas
              aria-label={ariaLabel}
              className="block"
              onPointerLeave={() => setHovered(undefined)}
              onPointerMove={handleCanvasPointerMove}
              ref={canvasRef}
              role="img"
              style={{ height: `${gridHeight}px`, width: `${gridWidth}px` }}
            />
          ) : null}
          <TooltipPortal
            className={cn(
              "min-w-[96px] -translate-x-1/2 px-2 py-1.5 text-left font-normal",
              theme.tooltipContentClassName,
              tooltipPosition?.below ? undefined : "-translate-y-full"
            )}
            open={Boolean(hoveredCell && tooltipPosition)}
            style={{ left: tooltipPosition?.left ?? 0, top: tooltipPosition?.top ?? 0 }}
          >
            <span className="block font-semibold">{hoveredCell?.dateLabel ?? ""}</span>
            <span className={cn("mt-0.5 block", theme.detailClassName ?? "text-muted-foreground")}>
              {tokenCount(hoveredCell?.totalTokens ?? 0)} {tokensLabel}
            </span>
          </TooltipPortal>
        </div>
      </div>
    </div>
  );
}
