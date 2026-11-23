import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  MAX_IMAGE_BYTES,
  attachmentKind,
} from "@crumble/server/contract/limits";
import type { Bot } from "@/features/bots/api";
import type { Upload } from "@/features/chat/composer";
import { modelsQuery, visionModelQuery } from "@/features/providers/api";

type ImageBot = Pick<Bot, "id" | "name" | "provider" | "model">;

const sentAsImage = (upload: Upload) =>
  attachmentKind(upload.mimeType) === "image" &&
  (upload.size ?? 0) <= MAX_IMAGE_BYTES;

function useReadsImages(bot: ImageBot) {
  const models = useQuery(modelsQuery(bot.provider));
  const vision = useQuery(visionModelQuery);
  const model = models.data?.find((each) => each.id === bot.model);

  if (!model || !vision.data) {
    return true;
  }

  return model.images || vision.data.visionModel !== null;
}

export function ImageWarning({
  bot,
  uploads,
}: {
  bot: ImageBot;
  uploads: Array<Upload>;
}) {
  const reads = useReadsImages(bot);

  if (reads || !uploads.some(sentAsImage)) {
    return null;
  }

  return (
    <p role="alert" className="text-xs text-destructive">
      {bot.name}&apos;s model ({bot.model}) can&apos;t read images. Choose a
      model that accepts images in{" "}
      <Link
        to="/bots/$botId/edit"
        params={{ botId: bot.id }}
        className="underline"
      >
        {bot.name}&apos;s profile
      </Link>
      , or set a{" "}
      <Link to="/settings/vision-model" className="underline">
        vision model
      </Link>{" "}
      to describe images for it.
    </p>
  );
}
