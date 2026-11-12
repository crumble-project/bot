import {
  IconFile,
  IconFileCode,
  IconFileSpreadsheet,
  IconFileText,
  IconFileTypePdf,
  IconFileWord,
  IconFileZip,
  IconMovie,
  IconMusic,
  IconPhoto,
  IconPresentation,
} from "@tabler/icons-react";

const FILE_ICONS: [RegExp, typeof IconFile][] = [
  [/^image\//, IconPhoto],
  [/^video\//, IconMovie],
  [/^audio\//, IconMusic],
  [/^application\/pdf$/, IconFileTypePdf],
  [/spreadsheet|excel|text\/csv/, IconFileSpreadsheet],
  [/presentation|powerpoint/, IconPresentation],
  [/wordprocessing|msword|opendocument\.text/, IconFileWord],
  [/zip|tar|rar|7z|compressed/, IconFileZip],
  [/json|xml|javascript|typescript|html|css|x-sh/, IconFileCode],
  [/^text\//, IconFileText],
];

export function fileIcon(mimeType: string) {
  return (
    FILE_ICONS.find(([pattern]) => pattern.test(mimeType))?.[1] ?? IconFile
  );
}
