import { useRef, useState, type DragEvent, type RefObject } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  IconArrowLeft,
  IconFolder,
  IconLayoutGrid,
  IconList,
  IconUpload,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ErrorAlert, Page } from "@/components/page";
import { apiRaw, bodyOf, queryClient } from "@/lib/api";
import { agentPath, botsQuery } from "@/features/bots/api";
import { groupPath, groupsQuery } from "@/features/group-chats/api";
import { MAX_FILE_BYTES } from "@crumble/server/contract/limits";
import { uploadFile, useFileDownload, type LibraryFile } from "./api";
import { type FileActions, FileGrid, FileTable } from "./files-view";

const PAGE_SIZE = 50;
const VIEW_KEY = "library-view";

type View = "list" | "grid";

function useView() {
  const [view, setView] = useState<View>(() =>
    localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list",
  );

  const change = (next: View) => {
    localStorage.setItem(VIEW_KEY, next);
    setView(next);
  };

  return [view, change] as const;
}

function useUploads(path: string) {
  const [pending, setPending] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);

  const upload = (files: File[]) => {
    const accepted = files.filter((file) => file.size <= MAX_FILE_BYTES);

    setErrors(
      files.flatMap((file) =>
        file.size > MAX_FILE_BYTES
          ? [`${file.name} is larger than 100 MB.`]
          : [],
      ),
    );
    setPending((count) => count + accepted.length);

    for (const file of accepted) {
      void uploadFile(path, file)
        .catch(() =>
          setErrors((current) => [
            ...current,
            `${file.name} could not be uploaded.`,
          ]),
        )
        .finally(() => setPending((count) => count - 1));
    }
  };

  return { pending, errors, upload };
}

function ViewSwitch({
  view,
  onView,
}: {
  view: View;
  onView: (view: View) => void;
}) {
  return (
    <div
      role="group"
      aria-label="View"
      className="flex rounded-lg border p-0.5"
    >
      <Button
        variant={view === "list" ? "secondary" : "ghost"}
        size="icon-xs"
        title="List view"
        aria-pressed={view === "list"}
        onClick={() => onView("list")}
      >
        <IconList />
      </Button>
      <Button
        variant={view === "grid" ? "secondary" : "ghost"}
        size="icon-xs"
        title="Grid view"
        aria-pressed={view === "grid"}
        onClick={() => onView("grid")}
      >
        <IconLayoutGrid />
      </Button>
    </div>
  );
}

function useLibraryTitle(kind: "bot" | "group", id: string) {
  const bots = useQuery({ ...botsQuery, enabled: kind === "bot" });
  const groups = useQuery({ ...groupsQuery, enabled: kind === "group" });

  const name = (kind === "bot" ? bots.data : groups.data)?.find(
    (owner) => owner.id === id,
  )?.name;

  return name ? `${name}'s library` : "Library";
}

function UploadButton({
  pickerRef,
  pending,
  visible,
  onFiles,
}: {
  pickerRef: RefObject<HTMLInputElement | null>;
  pending: number;
  visible: boolean;
  onFiles: (files: File[]) => void;
}) {
  return (
    <>
      {visible && (
        <Button onClick={() => pickerRef.current?.click()}>
          {pending > 0 ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <IconUpload data-icon="inline-start" />
          )}
          {pending > 0 ? `Uploading ${pending}…` : "Upload"}
        </Button>
      )}
      <input
        ref={pickerRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
    </>
  );
}

function LibraryEmpty({ onUpload }: { onUpload: () => void }) {
  return (
    <Empty className="rounded-xl border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <IconFolder />
        </EmptyMedia>
        <EmptyTitle className="font-heading text-lg">No files yet</EmptyTitle>
        <EmptyDescription>
          Files you send in this chat appear here. You can also drop files here
          or upload them.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={onUpload}>
          <IconUpload data-icon="inline-start" />
          Upload
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function LibraryFiles({
  files,
  loaded,
  view,
  actions,
  onUpload,
}: {
  files: LibraryFile[];
  loaded: boolean;
  view: View;
  actions: FileActions;
  onUpload: () => void;
}) {
  if (files.length === 0)
    return loaded ? <LibraryEmpty onUpload={onUpload} /> : null;

  return view === "grid" ? (
    <FileGrid files={files} actions={actions} />
  ) : (
    <FileTable files={files} actions={actions} />
  );
}

function useDropZone(onDrop: (files: File[]) => void) {
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  const hasFiles = (event: DragEvent) =>
    event.dataTransfer.types.includes("Files");

  return {
    over,
    handlers: {
      onDragEnter: (event: DragEvent) => {
        if (!hasFiles(event)) return;

        depth.current += 1;
        setOver(true);
      },
      onDragLeave: (event: DragEvent) => {
        if (!hasFiles(event)) return;

        depth.current -= 1;

        if (depth.current === 0) setOver(false);
      },
      onDragOver: (event: DragEvent) => {
        if (hasFiles(event)) event.preventDefault();
      },
      onDrop: (event: DragEvent) => {
        if (!hasFiles(event)) return;

        event.preventDefault();
        depth.current = 0;
        setOver(false);
        onDrop([...event.dataTransfer.files]);
      },
    },
  };
}

function useLibraryFiles(kind: "bot" | "group", id: string, path: string) {
  const key = ["library", kind, id];
  const download = useFileDownload();

  const files = useInfiniteQuery({
    queryKey: key,
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });

      if (pageParam) query.set("before", pageParam);

      const response = await apiRaw(`${path}?${query}`, { signal });

      return bodyOf<"listFiles">(response);
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

  const pathOf = (file: LibraryFile) =>
    `${path}/${encodeURIComponent(file.id)}`;

  const actions: FileActions = {
    pathOf,
    download: (file) =>
      download.mutate({
        path: pathOf(file),
        name: file.name,
        mimeType: file.mimeType,
      }),
    downloading: download.isPending,
    remove: (file) => remove.mutate(file.id),
    removing: remove.isPending,
    removeError: remove.error,
  };

  return {
    files,
    entries: files.data?.pages.flat() ?? [],
    actions,
    downloadError: download.error,
  };
}

function BackToChat({ kind, id }: { kind: "bot" | "group"; id: string }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title="Back to chat"
      render={
        kind === "bot" ? (
          <Link to="/bots/$botId" params={{ botId: id }} />
        ) : (
          <Link to="/groups/$groupId" params={{ groupId: id }} />
        )
      }
      nativeButton={false}
    >
      <IconArrowLeft />
    </Button>
  );
}

function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85 backdrop-blur-sm">
      <span className="flex flex-col items-center gap-2 text-sm font-medium">
        <IconUpload className="size-8 text-primary" stroke={1.5} />
        Drop files to add them to the library
      </span>
    </div>
  );
}

export function Library({ kind, id }: { kind: "bot" | "group"; id: string }) {
  const path = `${kind === "bot" ? agentPath(id) : groupPath(id)}/files`;
  const title = useLibraryTitle(kind, id);
  const [view, setView] = useView();
  const uploads = useUploads(path);
  const drop = useDropZone(uploads.upload);
  const picker = useRef<HTMLInputElement>(null);

  const { files, entries, actions, downloadError } = useLibraryFiles(
    kind,
    id,
    path,
  );

  const openPicker = () => picker.current?.click();

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop.handlers}>
      <Page
        title={title}
        back={<BackToChat kind={kind} id={id} />}
        refreshing={files.isFetching}
        onRefresh={() => void files.refetch()}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <UploadButton
              pickerRef={picker}
              pending={uploads.pending}
              visible={entries.length > 0 || uploads.pending > 0}
              onFiles={uploads.upload}
            />
            {entries.length > 0 && <ViewSwitch view={view} onView={setView} />}
          </div>
          {[
            ...uploads.errors,
            files.error?.message,
            downloadError?.message,
          ].flatMap((error) =>
            error === undefined
              ? []
              : [<ErrorAlert key={error}>{error}</ErrorAlert>],
          )}
          {files.isPending && <Skeleton className="h-40 rounded-xl" />}
          <LibraryFiles
            files={entries}
            loaded={files.isSuccess}
            view={view}
            actions={actions}
            onUpload={openPicker}
          />
          {files.hasNextPage && (
            <Button
              variant="ghost"
              className="self-center"
              disabled={files.isFetchingNextPage}
              onClick={() => void files.fetchNextPage()}
            >
              Load more
            </Button>
          )}
        </div>
      </Page>
      {drop.over && <DropOverlay />}
    </div>
  );
}
