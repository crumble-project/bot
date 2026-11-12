import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRaw, bodyOf } from "@/lib/api";
import { agentPath } from "@/features/bots/api";
import { useFileDownload } from "./api";
import { fileIcon } from "./file-icon";

const RECENT_COUNT = 5;

export function RecentFiles({
  botId,
  onNavigate,
}: {
  botId: string;
  onNavigate: () => void;
}) {
  const path = `${agentPath(botId)}/files`;
  const download = useFileDownload();

  const files = useQuery({
    queryKey: ["library", "bot", botId, "recent"],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ limit: String(RECENT_COUNT) });
      const response = await apiRaw(`${path}?${query}`, { signal });

      return bodyOf<"listFiles">(response);
    },
  });

  const entries = files.data ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Library</h2>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0"
          render={<Link to="/bots/$botId/library" params={{ botId }} />}
          nativeButton={false}
          onClick={onNavigate}
        >
          See all
        </Button>
      </div>
      {files.isPending && <Skeleton className="h-10" />}
      {files.error && (
        <p role="alert" className="text-sm text-destructive">
          {files.error.message}
        </p>
      )}
      {download.error && (
        <p role="alert" className="text-sm text-destructive">
          {download.error.message}
        </p>
      )}
      {entries.map((file) => {
        const Icon = fileIcon(file.mimeType);

        return (
          <button
            key={file.id}
            type="button"
            title={`Download ${file.name}`}
            disabled={download.isPending}
            className="flex items-center gap-3 text-left"
            onClick={() =>
              download.mutate({
                path: `${path}/${encodeURIComponent(file.id)}`,
                name: file.name,
                mimeType: file.mimeType,
              })
            }
          >
            <Icon
              aria-hidden
              className="size-5 shrink-0 text-muted-foreground"
              stroke={1.5}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{file.name}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(file.createdAt).toLocaleDateString()}
              </span>
            </span>
          </button>
        );
      })}
      {files.isSuccess && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">No files yet</p>
      )}
    </section>
  );
}
