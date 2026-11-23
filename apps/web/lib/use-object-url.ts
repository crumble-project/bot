import { useCallback, useRef } from "react";

type MediaElement = HTMLImageElement | HTMLAudioElement | HTMLVideoElement;

export function useObjectUrl(blob: Blob | undefined) {
  const attached = useRef<{ blob: Blob; url: string } | undefined>(undefined);

  return useCallback(
    (element: MediaElement | null) => {
      const current = attached.current;

      if (!element) {
        if (current) {
          URL.revokeObjectURL(current.url);
          attached.current = undefined;
        }

        return;
      }

      if (!blob) {
        return;
      }

      let entry = current;

      if (!entry || entry.blob !== blob) {
        if (entry) {
          URL.revokeObjectURL(entry.url);
        }

        entry = { blob, url: URL.createObjectURL(blob) };
        attached.current = entry;
      }

      element.src = entry.url;
    },
    [blob],
  );
}
