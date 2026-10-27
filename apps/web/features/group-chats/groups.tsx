import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type Bot,
  type GroupChat,
  type GroupChatSnapshot,
  type Message,
  botsQuery,
  call,
  follow,
  groupChatQuery,
  groupPath,
  groupsQuery,
  queryClient,
  send,
} from "@/lib/api";
import { BotAvatar, botColor } from "@/features/bots/avatar";
import {
  ConfirmDeleteContent,
  MobileSidebarTrigger,
} from "@/components/workspace";
import { outgoingMessage } from "@/features/chat/chat";
import { confirm, useOutgoing } from "@/features/chat/delivery";
import {
  ConversationEmpty,
  ConversationError,
  ConversationLoading,
  ConversationRows,
  ConversationScroller,
  LoadEarlier,
  useHistory,
  useMessageSending,
} from "@/features/chat/conversation";
import {
  BotMessage,
  OwnerMessage,
  TypingDots,
  ARRIVAL,
  useArrivals,
  mergeMessages,
  reactionsOf,
} from "@/features/chat/transcript";
import { Composer } from "@/features/chat/composer";

function isShown(message: Message) {
  return (
    (message.role === "user" || message.role === "assistant") &&
    (message.content.trim() !== "" || Boolean(message.attachments?.length))
  );
}

function senderBot(message: Message, byId: Map<string, Bot>) {
  return message.origin?.agentId ? byId.get(message.origin.agentId) : undefined;
}

function replyLabel(replyTo: Message | null) {
  if (!replyTo) return undefined;

  return replyTo.role === "user" ? "You" : (replyTo.origin?.name ?? "a bot");
}

const MEMBER_STATUS = {
  running: "is answering",
  queued: "answers next",
  disabled: "is disabled and skipped",
  idle: "is here",
};

function useGroupFollow(groupId: string, path: string) {
  const navigate = useNavigate();

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
}

function GroupHeader({
  groupId,
  name,
  members,
  statusOf,
}: {
  groupId: string;
  name: string;
  members: Bot[];
  statusOf: (id: string) => { status: keyof typeof MEMBER_STATUS } | undefined;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
      <MobileSidebarTrigger />
      <span className="truncate font-heading font-semibold">{name}</span>
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
  );
}

function GroupActivityRows({
  activity,
  byId,
}: {
  activity: GroupChatSnapshot["activity"];
  byId: Map<string, Bot>;
}) {
  const working = activity.members.filter(
    (member) => member.status === "running",
  );

  const failures = activity.members.filter((member) => member.error);

  return (
    <>
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
              {byId.get(member.agentId)?.name ?? "A bot"} couldn't finish
            </AlertTitle>
            <AlertDescription>{member.error}</AlertDescription>
          </Alert>
        </MessageScrollerItem>
      ))}
      {activity.paused && (
        <MessageScrollerItem messageId="paused">
          <p className="text-center text-sm text-muted-foreground">
            The bots are waiting for you. Your next message lets them continue.
          </p>
        </MessageScrollerItem>
      )}
    </>
  );
}

function isRunning(activity: GroupChatSnapshot["activity"]) {
  return activity.members.some(
    (member) => member.status === "running" || member.status === "queued",
  );
}

function earliestOf(
  older: { hasMore: boolean; oldestEntryId: string | null } | null | undefined,
  live: GroupChatSnapshot,
) {
  const page = older ?? live;

  return { hasMore: page.hasMore, oldest: page.oldestEntryId };
}

function colorOf(message: Message, byId: Map<string, Bot>) {
  const bot = senderBot(message, byId);

  return bot ? botColor(bot) : undefined;
}

function SendError({ message }: { message: string | null | undefined }) {
  if (!message) return null;

  return (
    <p className="mx-auto w-full max-w-3xl px-4 text-xs text-destructive">
      {message}
    </p>
  );
}

function useConfirmed(groupId: string, live: Message[] | undefined) {
  useEffect(() => {
    if (live)
      confirm(
        `group:${groupId}`,
        new Set(live.flatMap((message) => message.requestId ?? [])),
      );
  }, [groupId, live]);
}

function membersOf(memberIds: string[], byId: Map<string, Bot>) {
  return memberIds.flatMap((id) => {
    const bot = byId.get(id);

    return bot ? [bot] : [];
  });
}

function GroupSender({
  message,
  byId,
}: {
  message: Message;
  byId: Map<string, Bot>;
}) {
  const bot = senderBot(message, byId);

  return (
    <span
      className="font-medium"
      style={bot ? { color: botColor(bot) } : undefined}
    >
      {message.origin?.name ?? bot?.name ?? "Bot"}
    </span>
  );
}

function useGroupChatSession(groupId: string) {
  const snapshot = useQuery(groupChatQuery(groupId));
  const bots = useQuery(botsQuery).data ?? [];
  const outgoing = useOutgoing(`group:${groupId}`);
  const path = groupPath(groupId);
  const sending = useMessageSending(`group:${groupId}`, path);

  useGroupFollow(groupId, path);

  const live = snapshot.data?.messages;
  const { arrival, remember } = useArrivals(live);
  const { older, loadEarlier } = useHistory(`${path}/history`, remember);

  useConfirmed(groupId, live);

  const stop = useMutation({ mutationFn: () => send(`${path}/stop`, "POST") });

  return {
    snapshot,
    bots,
    outgoing,
    path,
    ...sending,
    arrival,
    older,
    loadEarlier,
    stop,
  };
}

export function GroupChatView({ groupId }: { groupId: string }) {
  const {
    snapshot,
    bots,
    outgoing,
    path,
    replyTo,
    setReplyTo,
    sendError,
    sendMessage,
    arrival,
    older,
    loadEarlier,
    stop,
  } = useGroupChatSession(groupId);

  if (snapshot.isError) return <ConversationError error={snapshot.error} />;

  if (!snapshot.data) return <ConversationLoading />;

  const { groupChat, activity } = snapshot.data;
  const byId = new Map(bots.map((bot) => [bot.id, bot]));

  const members = membersOf(groupChat.memberIds, byId);

  const statusOf = (id: string) =>
    activity.members.find((member) => member.agentId === id);

  const messages = mergeMessages(older?.messages ?? [], snapshot.data.messages);

  const shown = messages.filter(isShown);

  const reactions = reactionsOf(messages, true);

  const byEntry = new Map(
    messages.map((message) => [message.entryId, message]),
  );

  const running = isRunning(activity);
  const { hasMore, oldest } = earliestOf(older, snapshot.data);

  const attachmentPath = (entryId: string, index: number) =>
    `${path}/attachments/${encodeURIComponent(entryId)}/${index}`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <GroupHeader
        groupId={groupId}
        name={groupChat.name}
        members={members}
        statusOf={statusOf}
      />
      <ConversationScroller>
        {hasMore && oldest && (
          <LoadEarlier
            pending={loadEarlier.isPending}
            onLoad={() => loadEarlier.mutate(oldest)}
          />
        )}
        {shown.length === 0 && outgoing.length === 0 && (
          <ConversationEmpty title="Start the conversation">
            Everyone here reads every message. Mention a bot with @ to ask only
            it.
          </ConversationEmpty>
        )}
        <ConversationRows
          messages={shown}
          arrival={arrival}
          byEntry={byEntry}
          reactions={reactions}
          onReply={setReplyTo}
          attachmentPath={attachmentPath}
          renderMessage={(message) => (
            <BotMessage
              message={message}
              sender={<GroupSender message={message} byId={byId} />}
              color={colorOf(message, byId)}
              reactions={reactions.get(message.entryId)}
              onReply={setReplyTo}
            />
          )}
        />
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
        <GroupActivityRows activity={activity} byId={byId} />
      </ConversationScroller>
      <SendError message={sendError} />
      <Composer
        key={groupId}
        placeholder={`Message ${groupChat.name}`}
        running={running}
        replyingTo={replyLabel(replyTo)}
        onCancelReply={() => setReplyTo(null)}
        mentionable={members.filter((member) => member.enabled)}
        onSend={(content, uploads) => sendMessage(content, uploads)}
        onStop={() => stop.mutate()}
      />
    </div>
  );
}

function GroupMemberField({
  bot,
  on,
  full,
  onToggle,
}: {
  bot: Bot;
  on: boolean;
  full: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel
          htmlFor={`member-${bot.id}`}
          className="flex items-center gap-2"
        >
          <BotAvatar bot={bot} size={22} />
          {bot.name}
          {!bot.enabled && <Badge variant="outline">Disabled</Badge>}
        </FieldLabel>
      </FieldContent>
      <Switch
        id={`member-${bot.id}`}
        checked={on}
        disabled={!on && full}
        onCheckedChange={onToggle}
      />
    </Field>
  );
}

function DeleteGroup({
  group,
  error,
  pending,
  onConfirm,
}: {
  group: GroupChat;
  error: Error | null;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
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
      <ConfirmDeleteContent
        title={`Delete ${group.name}?`}
        description="The group chat and its messages will be removed. The bots stay. This cannot be undone."
        error={error}
        pending={pending}
        onConfirm={onConfirm}
      />
    </AlertDialog>
  );
}

function GroupFormButtons({
  group,
  valid,
  pending,
}: {
  group?: GroupChat | undefined;
  valid: boolean;
  pending: boolean;
}) {
  const navigate = useNavigate();

  return (
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
      <Button type="submit" disabled={!valid || pending}>
        {group ? "Save" : "Create group chat"}
      </Button>
    </div>
  );
}

function isValidGroup(name: string, memberIds: string[]) {
  return name.trim() !== "" && memberIds.length >= 2 && memberIds.length <= 6;
}

/** Creates a group chat, or edits `group` when given. */
export function GroupForm({ group }: { group?: GroupChat }) {
  const navigate = useNavigate();
  const bots = useQuery(botsQuery).data ?? [];
  const [name, setName] = useState(group?.name ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(group?.memberIds ?? []);

  const valid = isValidGroup(name, memberIds);

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
            {bots.map((bot) => (
              <GroupMemberField
                key={bot.id}
                bot={bot}
                on={memberIds.includes(bot.id)}
                full={memberIds.length >= 6}
                onToggle={(next) => toggle(bot, next)}
              />
            ))}
          </FieldGroup>
        </FieldSet>
        {save.isError && <FieldError>{save.error.message}</FieldError>}
        <div className="flex items-center gap-2">
          {group && (
            <DeleteGroup
              group={group}
              error={remove.error}
              pending={remove.isPending}
              onConfirm={() => remove.mutate(group.id)}
            />
          )}
          <GroupFormButtons
            group={group}
            valid={valid}
            pending={save.isPending}
          />
        </div>
      </form>
    </div>
  );
}
