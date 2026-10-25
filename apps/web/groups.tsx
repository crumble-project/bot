import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn, randomId } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type Bot,
  type GroupChat,
  type HistoryPage,
  type Message,
  api,
  botsQuery,
  call,
  follow,
  groupChatQuery,
  groupPath,
  groupsQuery,
  queryClient,
  send,
} from "./api";
import { BotAvatar, botColor } from "./avatar";
import { outgoingMessage } from "./chat";
import { confirm, deliver, useOutgoing } from "./delivery";
import {
  BotMessage,
  Composer,
  OwnerMessage,
  TimeMarker,
  TypingDots,
  ARRIVAL,
  useArrivals,
  type Upload,
  mergeMessages,
  reactionsOf,
  withTimeMarkers,
} from "./transcript";

const MEMBER_STATUS = {
  running: "is answering",
  queued: "answers next",
  disabled: "is disabled and skipped",
  idle: "is here",
};

export function GroupChatView({ groupId }: { groupId: string }) {
  const navigate = useNavigate();
  const snapshot = useQuery(groupChatQuery(groupId));
  const bots = useQuery(botsQuery).data ?? [];
  const outgoing = useOutgoing(`group:${groupId}`);
  const [older, setOlder] = useState<HistoryPage | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const path = groupPath(groupId);

  useEffect(() => {
    const controller = new AbortController();

    void follow(
      `${path}/events`,
      {
        onOpen: () =>
          void queryClient.invalidateQueries({
            queryKey: groupChatQuery(groupId).queryKey,
          }),
        onEvent: (event, data) => {
          if (event === "snapshot")
            queryClient.setQueryData(
              groupChatQuery(groupId).queryKey,
              JSON.parse(data),
            );
        },
        onGone: () => {
          void queryClient.invalidateQueries({
            queryKey: groupsQuery.queryKey,
          });
          void navigate({ to: "/" });
        },
      },
      controller.signal,
    );

    return () => controller.abort();
  }, [groupId, path, navigate]);

  const live = snapshot.data?.messages;
  const { arrival, remember } = useArrivals(live);

  useEffect(() => {
    if (live)
      confirm(
        `group:${groupId}`,
        new Set(live.flatMap((message) => message.requestId ?? [])),
      );
  }, [groupId, live]);

  const loadEarlier = useMutation({
    mutationFn: (before: string) =>
      api<HistoryPage>(
        `${path}/history?before=${encodeURIComponent(before)}&limit=100`,
      ),
    onSuccess: (page) => {
      remember(page.messages);
      setOlder({
        messages: mergeMessages(page.messages, older?.messages ?? []),
        hasMore: page.hasMore,
        oldestEntryId: page.oldestEntryId,
      });
    },
  });

  const stop = useMutation({ mutationFn: () => send(`${path}/stop`, "POST") });

  if (snapshot.isError)
    return (
      <Alert variant="destructive" className="m-6 w-auto">
        <AlertDescription>{snapshot.error.message}</AlertDescription>
      </Alert>
    );

  if (!snapshot.data)
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        <Skeleton className="h-10 w-1/2 self-end" />
        <Skeleton className="h-20 w-3/4" />
      </div>
    );

  const { groupChat, activity } = snapshot.data;
  const byId = new Map(bots.map((bot) => [bot.id, bot]));

  const members = groupChat.memberIds.flatMap((id) => {
    const bot = byId.get(id);

    return bot ? [bot] : [];
  });

  const statusOf = (id: string) =>
    activity.members.find((member) => member.agentId === id);

  const messages = mergeMessages(older?.messages ?? [], snapshot.data.messages);

  const shown = messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      (message.content.trim() !== "" || Boolean(message.attachments?.length)),
  );

  const reactions = reactionsOf(messages, true);

  const byEntry = new Map(
    messages.map((message) => [message.entryId, message]),
  );

  const working = activity.members.filter(
    (member) => member.status === "running",
  );

  const running = activity.members.some(
    (member) => member.status === "running" || member.status === "queued",
  );

  const failures = activity.members.filter((member) => member.error);
  const hasMore = older ? older.hasMore : snapshot.data.hasMore;
  const oldest = older ? older.oldestEntryId : snapshot.data.oldestEntryId;

  const attachmentPath = (entryId: string, index: number) =>
    `${path}/attachments/${encodeURIComponent(entryId)}/${index}`;

  const quoteOf = (message: Message) =>
    message.replyPreview ??
    (message.replyTo ? byEntry.get(message.replyTo)?.content : undefined);

  const sendMessage = async (
    content: string,
    uploads: Upload[],
    requestId: string = randomId(),
    target = replyTo?.entryId,
  ) => {
    setReplyTo(null);
    setSendError(null);

    const failure = await deliver(`group:${groupId}`, `${path}/messages`, {
      requestId,
      content,
      uploads,
      ...(target && { replyTo: target }),
    });

    if (failure) setSendError(`Message was not confirmed: ${failure}`);

    return failure === null;
  };

  const colorOf = (message: Message) => {
    const bot = message.origin?.agentId
      ? byId.get(message.origin.agentId)
      : undefined;

    return bot ? botColor(bot) : undefined;
  };

  const sender = (message: Message) => {
    const bot = message.origin?.agentId
      ? byId.get(message.origin.agentId)
      : undefined;

    return (
      <span
        className="font-medium"
        style={bot ? { color: botColor(bot) } : undefined}
      >
        {message.origin?.name ?? bot?.name ?? "Bot"}
      </span>
    );
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <span className="truncate font-heading font-semibold">
          {groupChat.name}
        </span>
        <div className="flex -space-x-1.5">
          {members.map((member) => {
            const status = statusOf(member.id)?.status ?? "idle";

            return (
              <Tooltip key={member.id}>
                <TooltipTrigger render={<span />}>
                  <BotAvatar
                    bot={member}
                    size={26}
                    state={status === "running" ? "working" : "idle"}
                    className={cn(status === "disabled" && "opacity-40")}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  {member.name} {MEMBER_STATUS[status]}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Edit group chat"
          className="ml-auto"
          render={<Link to="/groups/$groupId/edit" params={{ groupId }} />}
          nativeButton={false}
        >
          <HugeiconsIcon icon={PencilEdit01Icon} />
        </Button>
      </header>
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl justify-end gap-3 p-6">
              {hasMore && oldest && (
                <MessageScrollerItem messageId="earlier">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mx-auto flex"
                    disabled={loadEarlier.isPending}
                    onClick={() => loadEarlier.mutate(oldest)}
                  >
                    Load earlier messages
                  </Button>
                </MessageScrollerItem>
              )}
              {shown.length === 0 && outgoing.length === 0 && (
                <MessageScrollerItem messageId="empty">
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle className="text-lg">
                        Start the conversation
                      </EmptyTitle>
                      <EmptyDescription>
                        Everyone here reads every message. Mention a bot with @
                        to ask only it.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </MessageScrollerItem>
              )}
              {withTimeMarkers(shown).map((row) =>
                row.kind === "time" ? (
                  <MessageScrollerItem key={row.key} messageId={row.key}>
                    <TimeMarker label={row.label} />
                  </MessageScrollerItem>
                ) : (
                  <MessageScrollerItem
                    key={row.message.id}
                    messageId={row.message.id}
                    className={arrival(row.message)}
                  >
                    {row.message.role === "user" ? (
                      <OwnerMessage
                        message={row.message}
                        quote={quoteOf(row.message)}
                        reactions={reactions.get(row.message.entryId)}
                        onReply={setReplyTo}
                        attachmentPath={attachmentPath}
                      />
                    ) : (
                      <BotMessage
                        message={row.message}
                        sender={sender(row.message)}
                        color={colorOf(row.message)}
                        reactions={reactions.get(row.message.entryId)}
                        onReply={setReplyTo}
                      />
                    )}
                  </MessageScrollerItem>
                ),
              )}
              {outgoing.map((message) => (
                <MessageScrollerItem
                  key={message.requestId}
                  messageId={message.requestId}
                  className={ARRIVAL}
                >
                  <OwnerMessage
                    message={outgoingMessage(message)}
                    uploads={message.uploads}
                    delivery={message.state}
                    onRetry={() =>
                      void sendMessage(
                        message.content,
                        message.uploads,
                        message.requestId,
                        message.replyTo,
                      )
                    }
                    attachmentPath={attachmentPath}
                  />
                </MessageScrollerItem>
              ))}
              {working.length > 0 && (
                <MessageScrollerItem messageId="working" className={ARRIVAL}>
                  <div className="flex items-center gap-2">
                    <div className="flex -space-x-1.5">
                      {working.flatMap((member) => {
                        const bot = byId.get(member.agentId);

                        return bot
                          ? [
                              <BotAvatar
                                key={bot.id}
                                bot={bot}
                                size={22}
                                state="working"
                              />,
                            ]
                          : [];
                      })}
                    </div>
                    <TypingDots />
                  </div>
                </MessageScrollerItem>
              )}
              {failures.map((member) => (
                <MessageScrollerItem
                  key={`failure-${member.agentId}`}
                  messageId={`failure-${member.agentId}`}
                >
                  <Alert variant="destructive">
                    <AlertTitle>
                      {byId.get(member.agentId)?.name ?? "A bot"} couldn't
                      finish
                    </AlertTitle>
                    <AlertDescription>{member.error}</AlertDescription>
                  </Alert>
                </MessageScrollerItem>
              ))}
              {activity.paused && (
                <MessageScrollerItem messageId="paused">
                  <p className="text-center text-sm text-muted-foreground">
                    The bots are waiting for you. Your next message lets them
                    continue.
                  </p>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      {sendError && (
        <p className="mx-auto w-full max-w-3xl px-4 text-xs text-destructive">
          {sendError}
        </p>
      )}
      <Composer
        key={groupId}
        placeholder={`Message ${groupChat.name}`}
        running={running}
        replyingTo={
          replyTo
            ? replyTo.role === "user"
              ? "You"
              : (replyTo.origin?.name ?? "a bot")
            : undefined
        }
        onCancelReply={() => setReplyTo(null)}
        mentionable={members.filter((member) => member.enabled)}
        onSend={(content, uploads) => sendMessage(content, uploads)}
        onStop={() => stop.mutate()}
      />
    </div>
  );
}

/** Creates a group chat, or edits `group` when given. */
export function GroupForm({ group }: { group?: GroupChat }) {
  const navigate = useNavigate();
  const bots = useQuery(botsQuery).data ?? [];
  const [name, setName] = useState(group?.name ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(group?.memberIds ?? []);

  const valid =
    name.trim() !== "" && memberIds.length >= 2 && memberIds.length <= 6;

  const save = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), memberIds };

      return group
        ? call<GroupChat, typeof input>(groupPath(group.id), "PATCH", input)
        : call<GroupChat, typeof input>("/v1/group-chats", "POST", input);
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: groupsQuery.queryKey });
      await queryClient.invalidateQueries({
        queryKey: groupChatQuery(saved.id).queryKey,
      });
      await navigate({ to: "/groups/$groupId", params: { groupId: saved.id } });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => send(groupPath(id), "DELETE"),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: groupsQuery.queryKey });
      await navigate({ to: "/" });
    },
  });

  const toggle = (bot: Bot, on: boolean) =>
    setMemberIds(
      on ? [...memberIds, bot.id] : memberIds.filter((id) => id !== bot.id),
    );

  return (
    <div className="flex-1 overflow-y-auto">
      <form
        className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6"
        onSubmit={(event) => {
          event.preventDefault();

          if (valid) save.mutate();
        }}
      >
        <FieldSet>
          <FieldLegend>
            {group ? `Edit ${group.name}` : "New group chat"}
          </FieldLegend>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="group-name">Name</FieldLabel>
              <Input
                id="group-name"
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </FieldGroup>
        </FieldSet>
        <FieldSet>
          <FieldLegend variant="label">Members</FieldLegend>
          <FieldDescription>
            Choose two to six bots. A bot added later gets a summary of the
            conversation so far.
          </FieldDescription>
          <FieldGroup>
            {bots.map((bot) => {
              const on = memberIds.includes(bot.id);

              return (
                <Field key={bot.id} orientation="horizontal">
                  <FieldContent>
                    <FieldLabel
                      htmlFor={`member-${bot.id}`}
                      className="flex items-center gap-2"
                    >
                      <BotAvatar bot={bot} size={22} />
                      {bot.name}
                      {!bot.enabled && (
                        <Badge variant="outline">Disabled</Badge>
                      )}
                    </FieldLabel>
                  </FieldContent>
                  <Switch
                    id={`member-${bot.id}`}
                    checked={on}
                    disabled={!on && memberIds.length >= 6}
                    onCheckedChange={(next) => toggle(bot, next)}
                  />
                </Field>
              );
            })}
          </FieldGroup>
        </FieldSet>
        {save.isError && <FieldError>{save.error.message}</FieldError>}
        <div className="flex items-center gap-2">
          {group && (
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  />
                }
              >
                Delete
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {group.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The group chat and its messages will be removed. The bots
                    stay. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                {remove.isError && (
                  <FieldError>{remove.error.message}</FieldError>
                )}
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(group.id)}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                void (group
                  ? navigate({
                      to: "/groups/$groupId",
                      params: { groupId: group.id },
                    })
                  : navigate({ to: "/" }))
              }
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {group ? "Save" : "Create group chat"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
