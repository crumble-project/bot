import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertDialog, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteContent } from "@/components/page";
import { apiRaw, queryClient } from "@/lib/api";
import { agentPath } from "@/features/bots/api";
import { groupPath } from "@/features/group-chats/api";
import { AttachmentImage } from "@/features/chat/transcript";
import { useFileDownload, isPreviewable, type LibraryFile } from "./api";

const PAGE_SIZE = 50;

export function Library({ kind, id }: { kind: "bot" | "group"; id: string }) {
  const path = `${kind === "bot" ? agentPath(id) : groupPath(id)}/files`;
  const key = ["library", kind, id];
  const download = useFileDownload();

  const files = useInfiniteQuery({
    queryKey: key,
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });

      if (pageParam) query.set("before", pageParam);

      const response = await apiRaw(`${path}?${query}`, { signal });
      const page: LibraryFile[] = await response.json();

      return page;
    },
    getNextPageParam: (page) =>
      page.length === PAGE_SIZE ? page.at(-1)?.id : undefined,
  });

  const remove = useMutation({
    mutationFn: async (fileId: string) => {
      await apiRaw(`${path}/${encodeURIComponent(fileId)}`, {
        method: "DELETE",
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({
          queryKey: [kind === "bot" ? "chat" : "group-chat", id],
        }),
      ]);
    },
  });

  const entries = files.data?.pages.flat() ?? [];

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          render={
            kind === "bot" ? (
              <Link to="/bots/$botId" params={{ botId: id }} />
            ) : (
              <Link to="/groups/$groupId" params={{ groupId: id }} />
            )
          }
          nativeButton={false}
        >
          Back
        </Button>
        <h1 className="text-xl font-semibold">Library</h1>
      </div>
      {files.isPending && <p>Loading…</p>}
      {files.error && <p role="alert">{files.error.message}</p>}
      {download.error && <p role="alert">{download.error.message}</p>}
      {files.isSuccess && entries.length === 0 && (
        <p className="text-muted-foreground">
          Files you send in this chat appear here.
        </p>
      )}
      {entries.map((file) => {
        const filePath = `${path}/${encodeURIComponent(file.id)}`;

        return (
          <div
            key={file.id}
            className="flex items-center gap-3 rounded-lg border p-3"
          >
            {isPreviewable(file.mimeType) && (
              <AttachmentImage
                path={filePath}
                name={file.name}
                mimeType={file.mimeType}
                className="size-14"
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{file.name}</span>
              <span className="text-sm text-muted-foreground">
                {file.mimeType} · {file.size.toLocaleString()} bytes ·{" "}
                {new Date(file.createdAt).toLocaleDateString()}
              </span>
            </div>
            <Button
              variant="outline"
              disabled={download.isPending}
              onClick={() =>
                download.mutate({
                  path: filePath,
                  name: file.name,
                  mimeType: file.mimeType,
                })
              }
            >
              Download
            </Button>
            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="ghost" />}>
                Delete
              </AlertDialogTrigger>
              <ConfirmDeleteContent
                title={`Delete ${file.name}?`}
                description="This file will be removed from the library. This cannot be undone."
                error={remove.error}
                pending={remove.isPending}
                onConfirm={() => remove.mutate(file.id)}
              />
            </AlertDialog>
          </div>
        );
      })}
      {files.hasNextPage && (
        <Button
          variant="outline"
          disabled={files.isFetchingNextPage}
          onClick={() => void files.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </main>
  );
}
