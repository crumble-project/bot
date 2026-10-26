import { useId, useLayoutEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown02Icon,
  ArrowRight02Icon,
  ArrowUp02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { ChartLayout, Message } from "@/lib/api";

type Stat = {
  label: string;
  value: string;
  change?: string;
  trend?: "up" | "down" | "flat";
  caption?: string;
};

type Display =
  | { kind: "stats"; title?: string; items: Stat[] }
  | {
      kind: "table";
      title?: string;
      columns: string[];
      rows: (string | number)[][];
    }
  | { kind: "chart"; title?: string; layouts: ChartLayout[] };

/** The `show` tool's component, from a successful tool result; unknown kinds are dropped. */
export function displayOf(message: Message): Display | null {
  if (message.toolName !== "show" || message.isError) return null;

  // SAFETY: The server validates `show` details against these three shapes before storing them.
  const details = message.toolDetails as Display | undefined;

  return details && ["stats", "table", "chart"].includes(details.kind)
    ? details
    : null;
}

export function DisplayCard({ display }: { display: Display }) {
  return (
    <div className="flex max-w-full flex-col gap-2 rounded-xl border p-3">
      {display.title && (
        <span className="text-sm font-medium">{display.title}</span>
      )}
      {display.kind === "stats" && <Stats items={display.items} />}
      {display.kind === "table" && (
        <Table columns={display.columns} rows={display.rows} />
      )}
      {display.kind === "chart" && <Chart layouts={display.layouts} />}
    </div>
  );
}

const TREND = {
  up: ArrowUp02Icon,
  down: ArrowDown02Icon,
  flat: ArrowRight02Icon,
};

function Stats({ items }: { items: Stat[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
      {items.map((item) => {
        const Icon = item.trend ? TREND[item.trend] : null;

        return (
          <div key={item.label} className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">{item.label}</span>
            <span className="text-2xl font-semibold tabular-nums">
              {item.value}
            </span>
            {item.change && (
              <span
                className={cn(
                  "flex items-center gap-1 text-xs",
                  item.trend === "up" &&
                    "text-emerald-600 dark:text-emerald-400",
                  item.trend === "down" && "text-destructive",
                  (!item.trend || item.trend === "flat") &&
                    "text-muted-foreground",
                )}
              >
                {Icon && <HugeiconsIcon icon={Icon} className="size-3" />}
                {item.change}
              </span>
            )}
            {item.caption && (
              <span className="text-xs text-muted-foreground">
                {item.caption}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const isNumber = (cell: string | number | undefined): cell is number =>
  Number.isFinite(cell);

function Table({
  columns,
  rows,
}: {
  columns: string[];
  rows: (string | number)[][];
}) {
  const numeric = columns.map((_, index) =>
    rows.every((row) => isNumber(row[index])),
  );

  const format = new Intl.NumberFormat();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-muted-foreground">
            {columns.map((column, index) => (
              <th
                key={column}
                className={cn(
                  "px-2 py-1.5 font-medium",
                  numeric[index] ? "text-right" : "text-left",
                )}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b last:border-0">
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={cn(
                    "px-2 py-1.5",
                    numeric[index] && "text-right tabular-nums",
                  )}
                >
                  {isNumber(cell) ? format.format(cell) : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Node = ChartLayout["nodes"][number];

type Point = ChartLayout["points"][number];

const SERIES = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function paint(color: string | undefined, fallback: string) {
  if (!color) return fallback;

  if (color === "foreground") return "var(--foreground)";

  if (color === "background") return "var(--background)";

  const series = /^series-(\d+)$/.exec(color);

  return series ? SERIES[Number(series[1]) % SERIES.length]! : color;
}

function pathData(commands: Extract<Node, { kind: "path" }>["commands"]) {
  return commands.map((command) => command.join(" ")).join(" ");
}

const BASELINES = new Map<string | undefined, "hanging" | "middle">([
  ["hanging", "hanging"],
  ["middle", "middle"],
]);

function commonProps(node: Node, id: string) {
  return {
    fill: paint(node.fill, node.kind === "line" ? "none" : "var(--foreground)"),
    fillOpacity: node.fillOpacity,
    stroke: paint(node.stroke, "none"),
    strokeOpacity: node.strokeOpacity,
    strokeWidth: node.strokeWidth,
    strokeLinecap: node.lineCap,
    // SAFETY: The server normalizes every line join to miter, round, or bevel.
    strokeLinejoin: node.lineJoin as "miter" | "round" | "bevel" | undefined,
    strokeDasharray: node.dash?.join(" "),
    opacity: node.opacity,
    clipPath: node.clip ? `url(#${id})` : undefined,
  };
}

type CommonProps = ReturnType<typeof commonProps>;

function ChartText({
  node,
  common,
}: {
  node: Extract<Node, { kind: "text" }>;
  common: CommonProps;
}) {
  return (
    <text
      {...common}
      x={node.x}
      y={node.y}
      fontSize={node.size}
      fontWeight={node.weight}
      textAnchor={node.anchor}
      dominantBaseline={BASELINES.get(node.baseline) ?? "auto"}
      transform={
        node.rotate ? `rotate(${node.rotate} ${node.x} ${node.y})` : undefined
      }
    >
      {node.text}
    </text>
  );
}

function ChartMark({ node, common }: { node: Node; common: CommonProps }) {
  switch (node.kind) {
    case "line":
      return (
        <line {...common} x1={node.x1} y1={node.y1} x2={node.x2} y2={node.y2} />
      );
    case "path":
      return (
        <path
          {...common}
          d={pathData(node.commands)}
          fillRule={node.evenOdd ? "evenodd" : "nonzero"}
        />
      );
    case "circle":
      return <circle {...common} cx={node.x} cy={node.y} r={node.radius} />;
    case "rect":
      return (
        <rect
          {...common}
          x={node.x}
          y={node.y}
          width={node.width}
          height={node.height}
          rx={node.radius}
        />
      );
    case "text":
      return <ChartText node={node} common={common} />;
  }
}

function ChartNode({ node, id }: { node: Node; id: string }) {
  return (
    <>
      {node.clip && (
        <clipPath id={id}>
          <rect
            x={node.clip[0]}
            y={node.clip[1]}
            width={node.clip[2]}
            height={node.clip[3]}
          />
        </clipPath>
      )}
      <ChartMark node={node} common={commonProps(node, id)} />
    </>
  );
}

/** Draws the server-compiled chart, choosing the widest layout that fits. */
function Chart({ layouts }: { layouts: ChartLayout[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Point | null>(null);
  const clipPrefix = `clip${useId().replace(/\W/g, "")}`;

  useLayoutEffect(() => {
    const element = box.current;

    if (!element) return;

    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry?.contentRect.width ?? 0),
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const sorted = [...layouts].sort((a, b) => a.width - b.width);

  const layout = sorted.findLast((each) => each.width <= width) ?? sorted[0];

  if (!layout) return null;

  const widest = sorted.at(-1)!.width;

  return (
    <div ref={box} className="relative w-full" style={{ maxWidth: widest }}>
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="h-auto w-full"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const scale = layout.width / rect.width;
          const x = (event.clientX - rect.left) * scale;
          const y = (event.clientY - rect.top) * scale;
          let best: Point | null = null;
          let distance = 32 * scale;

          for (const point of layout.points) {
            const d = Math.hypot(point.x - x, point.y - y);

            if (d < distance) {
              best = point;
              distance = d;
            }
          }

          setHover(best);
        }}
      >
        {layout.nodes.map((node, index) => (
          <ChartNode key={index} node={node} id={`${clipPrefix}-${index}`} />
        ))}
        {hover && (
          <circle
            cx={hover.x}
            cy={hover.y}
            r={5}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={2}
          />
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
          style={{
            left: `${(hover.x / layout.width) * 100}%`,
            top: `${(hover.y / layout.height) * 100}%`,
            transform: "translate(-50%, calc(-100% - 10px))",
          }}
        >
          {"title" in hover && hover.title && (
            <div className="font-medium">{hover.title}</div>
          )}
          {"text" in hover && <div>{hover.text}</div>}
          {hover.rows.map((row) => (
            <div key={row.label} className="flex justify-between gap-3">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="tabular-nums">{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
