import { useState } from "react";
import { IconDownload, IconTrash } from "@tabler/icons-react";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDeleteContent, RowMenu } from "@/components/page";
import { Heading, TableFrame } from "@/components/table-frame";
import { AttachmentImage } from "@/features/chat/transcript";
import { isPreviewable, type LibraryFile } from "./api";
import { fileIcon } from "./file-icon";
import { cn } from "@/lib/utils";

const SIZE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

export type FileActions = {
  pathOf: (file: LibraryFile) => string;
  download: (file: LibraryFile) => void;
  downloading: boolean;
  remove: (file: LibraryFile) => void;
  removing: boolean;
  removeError: Error | null;
};

function formatSize(bytes: number) {
  let value = bytes;
  let unit = 0;

  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }

  return new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: SIZE_UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

function modifiedLabel(createdAt: string) {
  const date = new Date(createdAt);
  const now = new Date();

  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });

  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
  };

  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";

  return date.toLocaleDateString(undefined, options);
}

function Preview({
  file,
  path,
  className,
  iconClassName,
}: {
  file: LibraryFile;
  path: string;
  className: string;
  iconClassName: string;
}) {
  if (isPreviewable(file.mimeType))
    return (
      <span className={cn("overflow-hidden bg-muted", className)}>
        <AttachmentImage
          path={path}
          name={file.name}
          mimeType={file.mimeType}
          className="size-full max-h-none max-w-none rounded-none object-cover outline-none"
        />
      </span>
    );

  const Icon = fileIcon(file.mimeType);

  return (
    <span
      className={cn(
        "flex items-center justify-center bg-muted text-muted-foreground",
        className,
      )}
    >
      <Icon aria-hidden className={iconClassName} stroke={1.5} />
    </span>
  );
}

function FileMenu({
  file,
  actions,
}: {
  file: LibraryFile;
  actions: FileActions;
}) {
  const [deleting, setDeleting] = useState(false);

  return (
    <span onClick={(event) => event.stopPropagation()}>
      <RowMenu>
        <DropdownMenuItem
          disabled={actions.downloading}
          onClick={() => actions.download(file)}
        >
          <IconDownload />
          Download
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => setDeleting(true)}
        >
          <IconTrash />
          Delete
        </DropdownMenuItem>
      </RowMenu>
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <ConfirmDeleteContent
          title={`Delete ${file.name}?`}
          description="This file will be removed from the library. This cannot be undone."
          error={actions.removeError}
          pending={actions.removing}
          onConfirm={() => actions.remove(file)}
        />
      </AlertDialog>
    </span>
  );
}

export function FileTable({
  files,
  actions,
}: {
  files: LibraryFile[];
  actions: FileActions;
}) {
  return (
    <TableFrame>
      <TableHeader>
        <TableRow className="border-0 hover:bg-transparent">
          <Heading>Name</Heading>
          <Heading className="hidden w-32 sm:table-cell">Modified</Heading>
          <Heading className="hidden w-28 text-right sm:table-cell">
            Size
          </Heading>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((file) => (
          <TableRow
            key={file.id}
            title={`Download ${file.name}`}
            className="cursor-pointer border-0"
            onClick={() => actions.download(file)}
          >
            <TableCell className="w-full max-w-0 py-2">
              <span className="flex min-w-0 items-center gap-3">
                <Preview
                  file={file}
                  path={actions.pathOf(file)}
                  className="size-8 shrink-0 rounded-md"
                  iconClassName="size-4.5"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{file.name}</span>
                  <span className="truncate text-xs text-muted-foreground sm:hidden">
                    {modifiedLabel(file.createdAt)} · {formatSize(file.size)}
                  </span>
                </span>
              </span>
            </TableCell>
            <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">
              {modifiedLabel(file.createdAt)}
            </TableCell>
            <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
              {formatSize(file.size)}
            </TableCell>
            <TableCell>
              <FileMenu file={file} actions={actions} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  );
}

export function FileGrid({
  files,
  actions,
}: {
  files: LibraryFile[];
  actions: FileActions;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
      {files.map((file) => (
        <div
          key={file.id}
          className="group/tile relative flex flex-col overflow-hidden rounded-xl surface"
        >
          <button
            type="button"
            title={`Download ${file.name}`}
            disabled={actions.downloading}
            className="flex flex-col text-left"
            onClick={() => actions.download(file)}
          >
            <Preview
              file={file}
              path={actions.pathOf(file)}
              className="aspect-4/3 w-full"
              iconClassName="size-10"
            />
            <span className="flex min-w-0 flex-col gap-0.5 p-2.5">
              <span className="truncate text-sm font-medium">{file.name}</span>
              <span className="truncate text-xs text-muted-foreground tabular-nums">
                {modifiedLabel(file.createdAt)} · {formatSize(file.size)}
              </span>
            </span>
          </button>
          <span className="absolute top-1.5 right-1.5 rounded-md bg-background/80 opacity-0 backdrop-blur-sm transition-opacity group-hover/tile:opacity-100 focus-within:opacity-100 has-aria-expanded:opacity-100 pointer-coarse:opacity-100">
            <FileMenu file={file} actions={actions} />
          </span>
        </div>
      ))}
    </div>
  );
}
