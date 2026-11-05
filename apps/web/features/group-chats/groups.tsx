import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { IconPencil } from "@tabler/icons-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { cn, numberWord } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type Bot, botsQuery } from "@/features/bots/api";
import {
  type GroupChat,
  type GroupChatSnapshot,
  groupChatQuery,
  groupPath,
  groupsQuery,
  membersOf,
} from "./api";
import type { Message } from "@/features/chat/api";
import { call, queryClient, send } from "@/lib/api";
import { BotAvatar, botColor } from "@/components/bot-avatar";
import { ConfirmDeleteContent, MobileSidebarTrigger } from "@/components/page";
import {
  ConversationEmpty,
  ConversationError,
  ConversationLoading,
  ConversationMessages,
  ConversationScroller,
  SendError,
  useConversation,
} from "@/features/chat/conversation";
import type { ConversationTarget } from "@/features/chat/conversation-target";
import {
  BotMessage,
  TypingDots,
  ARRIVAL,
  hasContent,
} from "@/features/chat/transcript";
import { Composer } from "@/features/chat/composer";
import { groupSourcesOf } from "@/features/chat/sources";
import {
  MAX_GROUP_MEMBERS,
  MAX_GROUP_NAME_CHARS,
  MIN_GROUP_MEMBERS,
} from "@crumble/server/contract/limits";
import { BotSwitchField } from "@/features/bots/bot-switch-field";

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

const groupConversation = (
  id: string,
): ConversationTarget<GroupChatSnapshot> => {
  const path = groupPath(id);

  return {
    key: `group:${id}`,
    path,
    history: `${path}/history`,
    query: groupChatQuery(id),
    shown: (message) =>
      (message.role === "user" || message.role === "assistant") &&
      hasContent(message),
    reactionTarget: (message) => message.replyTo,
    sendContext: () => ({}),
    stop: () => send<"stopGroupChat">(`${path}/stop`, "POST"),
    followsAfterView: () => false,
    refreshList: () =>
      queryClient.invalidateQueries({ queryKey: groupsQuery.queryKey }),
  };
};

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
        <IconPencil />
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

function colorOf(message: Message, byId: Map<string, Bot>) {
  const bot = senderBot(message, byId);

  return bot ? botColor(bot) : undefined;
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

export function GroupChatView({ groupId }: { groupId: string }) {
  const target = useMemo(() => groupConversation(groupId), [groupId]);
  const { snapshot, ...conversation } = useConversation(target);
  const bots = useQuery(botsQuery).data ?? [];
  const { replyTo, setReplyTo, sendError, sendMessage } = conversation.sending;

  if (snapshot.isError) return <ConversationError error={snapshot.error} />;

  if (!snapshot.data) return <ConversationLoading />;

  const { groupChat, activity } = snapshot.data;
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const members = membersOf(groupChat.memberIds, byId);

  const statusOf = (id: string) =>
    activity.members.find((member) => member.agentId === id);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <GroupHeader
        groupId={groupId}
        name={groupChat.name}
        members={members}
        statusOf={statusOf}
      />
      <ConversationScroller>
        <ConversationMessages
          conversation={conversation}
          empty={
            <ConversationEmpty title="Start the conversation">
              Everyone here reads every message. Mention a bot with @ to ask
              only it.
            </ConversationEmpty>
          }
          renderMessage={(message) => (
            <BotMessage
              message={message}
              sender={<GroupSender message={message} byId={byId} />}
              color={colorOf(message, byId)}
              reactions={conversation.reactions.get(message.entryId)}
              sources={groupSourcesOf(message)}
              onReply={setReplyTo}
            />
          )}
        />
        <GroupActivityRows activity={activity} byId={byId} />
      </ConversationScroller>
      <SendError message={sendError} />
      <Composer
        key={groupId}
        draftKey={target.key}
        placeholder={`Message ${groupChat.name}`}
        running={isRunning(activity)}
        replyingTo={replyLabel(replyTo)}
        onCancelReply={() => setReplyTo(null)}
        mentionable={members.filter((member) => member.enabled)}
        onSend={(content, uploads) => sendMessage(content, uploads)}
        onStop={() => conversation.stop.mutate()}
      />
    </div>
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
  return (
    name.trim() !== "" &&
    memberIds.length >= MIN_GROUP_MEMBERS &&
    memberIds.length <= MAX_GROUP_MEMBERS
  );
}

/** Creates a group chat, or edits `group` when given. */
export function GroupForm({ group }: { group?: GroupChat }) {
  const navigate = useNavigate();
  const bots = useQuery(botsQuery).data ?? [];
  const [name, setName] = useState(group?.name ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(group?.memberIds ?? []);

  const valid = isValidGroup(name, memberIds);
  const selected = new Set(memberIds);

  const save = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), memberIds };

      return group
        ? call<"updateGroupChat">(groupPath(group.id), "PATCH", input)
        : call<"createGroupChat">("/v1/group-chats", "POST", input);
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
    mutationFn: (id: string) =>
      send<"deleteGroupChat">(groupPath(id), "DELETE"),
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
    <ScrollArea className="min-h-0 flex-1">
      <form
        className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6"
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
                maxLength={MAX_GROUP_NAME_CHARS}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </FieldGroup>
        </FieldSet>
        <FieldSet>
          <FieldLegend variant="label">Members</FieldLegend>
          <FieldDescription>
            {`Choose ${numberWord(MIN_GROUP_MEMBERS)} to ${numberWord(MAX_GROUP_MEMBERS)} bots. A bot added later gets a summary of the conversation so far.`}
          </FieldDescription>
          <FieldGroup>
            {bots.map((bot) => (
              <BotSwitchField
                key={bot.id}
                id={`member-${bot.id}`}
                bot={bot}
                checked={selected.has(bot.id)}
                disabled={
                  !selected.has(bot.id) && memberIds.length >= MAX_GROUP_MEMBERS
                }
                onCheckedChange={(next) => toggle(bot, next)}
              >
                {!bot.enabled && <Badge variant="outline">Disabled</Badge>}
              </BotSwitchField>
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
    </ScrollArea>
  );
}
