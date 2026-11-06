import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { Change } from "./api";
import { queryClient, send } from "@/lib/api";
import { activityKey } from "./api";
import { invalidateMemories } from "@/features/memory/api";
import { invalidateSkills } from "@/features/skills/skill-cache";

const VERBS: Record<Change["action"], string> = {
  create: "added",
  update: "changed",
  delete: "deleted",
  revert: "reverted",
};

function actorLabel(change: Change, botName: string | null) {
  switch (change.actor) {
    case "owner":
      return "You";
    case "bot":
      return botName ?? "A bot";
    case "review":
      return botName ? `${botName}'s review` : "A review";
    case "curator":
      return "The curator";
  }
}

export function changeSummary(change: Change, botName: string | null) {
  const target =
    change.target === "skill"
      ? "a skill"
      : change.agentId
        ? "a memory"
        : "a shared memory";

  return `${actorLabel(change, botName)} ${VERBS[change.action]} ${target}`;
}

export function changeTitle(change: Change) {
  const state = change.after ?? change.before;

  if (!state) return change.targetId;

  if ("content" in state) return state.content.split("\n")[0] ?? "";

  return state.name;
}

/** Reverts a change after confirming; the server records the revert as a change of its own. */
export function RevertChange({ change }: { change: Change }) {
  const target = change.target === "skill" ? "skill" : "memory";

  const revert = useMutation({
    mutationFn: () =>
      send<"revertChange">(
        `/v1/changes/${encodeURIComponent(change.id)}/revert`,
        "POST",
      ),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: activityKey }),
        invalidateMemories(),
        invalidateSkills(),
      ]),
  });

  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button variant="ghost" size="sm" disabled={revert.isPending}>
              Revert
            </Button>
          }
        />
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert this change?</AlertDialogTitle>
            <AlertDialogDescription>
              {change.before
                ? `The ${target} goes back to how it was before this change. Anything changed since is replaced. The revert is recorded, so you can undo it too.`
                : `The ${target} is deleted again. The revert is recorded, so you can undo it too.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => revert.mutate()}>
              Revert
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {revert.isError && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{revert.error.message}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
