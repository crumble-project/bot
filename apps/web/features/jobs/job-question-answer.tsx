import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  IconArrowUp,
  IconCircle,
  IconMessageQuestion,
  IconSquare,
  IconSquareCheckFilled,
} from "@tabler/icons-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { agentPath, queryClient, send } from "@/lib/api";

export type Question = {
  id: string;
  text: string;
  options?: string[] | undefined;
  multiple?: boolean | undefined;
};

/** One option row: a radio for a single choice, a checkbox for several. */
function OptionRow({
  option,
  multiple,
  picked,
  sending,
  disabled,
  onPick,
}: {
  option: string;
  multiple: boolean;
  picked: boolean;
  sending: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const Mark = sending
    ? Spinner
    : multiple
      ? picked
        ? IconSquareCheckFilled
        : IconSquare
      : IconCircle;

  return (
    <button
      type="button"
      role={multiple ? "checkbox" : undefined}
      aria-checked={multiple ? picked : undefined}
      disabled={disabled}
      onClick={onPick}
      className={cn(
        "flex min-h-9 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-150 ease-out outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
        picked && "bg-muted",
      )}
    >
      <Mark
        className={cn(
          "size-4 shrink-0",
          picked ? "text-foreground" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 text-pretty">{option}</span>
    </button>
  );
}

/** The owner's answer box for a coding job's open question; the answer resumes the job. */
export function JobQuestionAnswer({
  botId,
  job,
  question,
}: {
  botId: string;
  job: string;
  question: Question;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const multiple = question.multiple === true;
  // A multiple-choice answer lists the picked options, then anything written.
  const reply = [picked.join(", "), text.trim()].filter(Boolean).join("\n");

  const answer = useMutation({
    mutationFn: (sent: string) =>
      send(
        `${agentPath(botId)}/coding-jobs/${encodeURIComponent(job)}/answer`,
        "POST",
        { questionId: question.id, text: sent },
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["jobs", botId, "coding"] }),
  });

  const submit = () => {
    if (reply && !answer.isPending) answer.mutate(reply);
  };

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-3 rounded-xl border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex items-start gap-3">
        <IconMessageQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-xs text-muted-foreground">
            {job} asks{multiple && " · pick any"}
          </span>
          <p className="text-sm font-medium text-pretty whitespace-pre-wrap">
            {question.text}
          </p>
        </div>
      </div>
      {question.options && (
        <div className="-mx-1.5 flex flex-col">
          {question.options.map((option) => {
            const on = picked.includes(option);

            return (
              <OptionRow
                key={option}
                option={option}
                multiple={multiple}
                picked={on || (!multiple && answer.variables === option)}
                sending={
                  !multiple && answer.isPending && answer.variables === option
                }
                disabled={answer.isPending}
                onPick={() =>
                  multiple
                    ? setPicked((current) =>
                        on
                          ? current.filter((each) => each !== option)
                          : [...current, option],
                      )
                    : answer.mutate(option)
                }
              />
            );
          })}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Answer"
          rows={1}
          className="min-h-8 resize-none py-1.5"
          placeholder={question.options ? "Something else…" : "Your answer…"}
          value={text}
          disabled={answer.isPending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          aria-label="Answer"
          title="Answer (⌘↵)"
          disabled={!reply || answer.isPending}
        >
          {answer.isPending && (multiple || !question.options) ? (
            <Spinner />
          ) : (
            <IconArrowUp />
          )}
        </Button>
      </div>
      {answer.isError && (
        <p className="text-xs text-destructive">{answer.error.message}</p>
      )}
    </form>
  );
}
