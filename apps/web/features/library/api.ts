import type { ResponseBody } from "@/lib/api";
import { apiRaw, HttpError, queryClient } from "@/lib/api";
import { useMutation } from "@tanstack/react-query";

export type LibraryFile = ResponseBody<"listFiles">[number];

export type UploadResponse = ResponseBody<"uploadFile">;

export async function uploadFile(
  path: string,
  file: File,
): Promise<UploadResponse> {
  const response = await apiRaw(path, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });

  const result: UploadResponse = await response.json();

  void queryClient.invalidateQueries({ queryKey: ["library"] });

  return result;
}

const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function safeBlob(bytes: Blob, mimeType: string): Blob {
  return bytes.slice(
    0,
    bytes.size,
    imageTypes.has(mimeType) ? mimeType : "application/octet-stream",
  );
}

export function isPreviewable(mimeType: string) {
  return imageTypes.has(mimeType);
}

export function useFileDownload() {
  return useMutation({
    mutationFn: (file: { path: string; name: string; mimeType: string }) =>
      downloadFile(file.path, file.name, file.mimeType),
    onError: (error) => {
      if (error instanceof HttpError && error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: ["library"] });
        void queryClient.invalidateQueries({ queryKey: ["chat"] });
        void queryClient.invalidateQueries({ queryKey: ["group-chat"] });
      }
    },
  });
}

export async function downloadFile(
  path: string,
  name: string,
  mimeType: string,
) {
  const response = await apiRaw(path);
  const blob = safeBlob(await response.blob(), mimeType);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
