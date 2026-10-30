import type { Context } from "@earendil-works/chord";
import {
  hostMatches,
  loginFieldInput,
  type LoginField,
} from "../shared/domain";
import type { ComputerUseArgs, ComputerUseResult } from "./computer-use";
import {
  codeOf,
  driverCall,
  listWindows,
  messageOf,
  ourNames,
  refusalOf,
  isChromium,
  sh,
} from "./computer-use-driver";
import {
  scrubText,
  textResult,
  type ComputerUseState,
} from "./computer-use-state";

/** What `fill_login` may know about a login: its name, hosts, and which fields it has; never a value. */
export type LoginSummary = {
  name: string;
  hosts: string[];
  fields: LoginField[];
};

/** A field's value for one fill, or why it can't be read. */
export type LoginRead =
  | { value: string }
  /** The login or field doesn't exist; nothing was read. */
  | { missing: string }
  /** Reading failed, such as an unreachable password manager. */
  | { unreadable: string };

/** The bot's logins, as the computer_use tool reaches them; values only through `read`. */
export type LoginFill = {
  list(): Promise<LoginSummary[]>;
  read(name: string, field: LoginField): Promise<LoginRead>;
  recordUse(
    name: string,
    use: { at: string; host: string; field: LoginField; error: string | null },
  ): Promise<void>;
};

/** A password typed on the desktop, the label that replaces it in results, and the Chromium it was typed into. */
export type DesktopFill = {
  value: string;
  label: string;
  browser: string;
};

/** The passwords typed on one bot desktop, kept for the desktop's life. */
export type DesktopFills = {
  list(): Promise<DesktopFill[]>;
  add(fill: DesktopFill): Promise<void>;
};

type Refusal = { refused: string };

type Target = {
  login: LoginSummary;
  field: LoginField;
  ref: string;
  host: string;
  ids: { target_id: string; tab_id: string };
};

const refused = (text: string): ComputerUseResult =>
  textResult(`REFUSED: ${text}`, true);

const noLoginFor = (host: string) =>
  `No login of this bot covers ${host}. Say so in your answer, naming ${host}, so the bot can ask the owner for a login.`;

/** The page the ref belongs to: the latest read's, since cua-driver refuses a ref once its page navigated. */
function pageOf(
  state: ComputerUseState,
  ref: string,
):
  | { latest: NonNullable<ComputerUseState["lastRead"]>; url: string }
  | Refusal {
  const latest = state.lastRead;

  if (!latest)
    return {
      refused: "read the sign-in page, then fill_login with a ref from it",
    };

  const element = latest.read.refs.find((each) => each.ref === ref);

  if (!element)
    return { refused: `${ref} is not in the latest read; read the page again` };

  if (element.frame !== "main")
    return {
      refused:
        "fill_login fills fields of the page itself, not of embedded frames",
    };

  if (element.role !== "textbox")
    return { refused: `${ref} is not a text field` };

  return { latest, url: latest.read.page?.url ?? latest.page.url };
}

function hostOf(url: string): { host: string } | Refusal {
  const parsed = URL.canParse(url) ? new URL(url) : undefined;

  if (parsed?.protocol !== "https:")
    return {
      refused: `fill_login fills https pages only, and this page is ${url}`,
    };

  return { host: parsed.hostname };
}

function loginFor(
  logins: LoginSummary[],
  name: string,
  host: string,
): LoginSummary | Refusal {
  const login = logins.find((each) => each.name === name);
  const covering = logins.filter((each) => hostMatches(each.hosts, host));

  if (login && hostMatches(login.hosts, host)) return login;

  if (!covering.length) return { refused: noLoginFor(host) };

  const names = covering.map((each) => each.name).join(", ");

  return {
    refused: login
      ? `login ${name} is for ${login.hosts.join(", ")}, not ${host}; logins for ${host}: ${names}`
      : `this bot has no login ${name}; logins for ${host}: ${names}`,
  };
}

/** Everything `fill_login` checks before reading a value; a refusal means nothing was read or typed. */
async function targetOf(
  state: ComputerUseState,
  logins: LoginFill,
  args: ComputerUseArgs,
): Promise<Target | Refusal> {
  const field = loginFieldInput.safeParse(args.field);

  if (!args.login || !field.success || !args.ref)
    return {
      refused:
        "fill_login needs login, field (username, password, or one_time_code), and ref",
    };

  const page = pageOf(state, args.ref);

  if ("refused" in page) return page;

  const host = hostOf(page.url);

  if ("refused" in host) return host;

  const login = loginFor(await logins.list(), args.login, host.host);

  if ("refused" in login) return login;

  return {
    login,
    field: field.data,
    ref: args.ref,
    host: host.host,
    ids: {
      target_id: page.latest.page.target_id,
      tab_id: page.latest.page.tab_id,
    },
  };
}

const label = (name: string, field: LoginField) => `[login ${name} ${field}]`;

/** Reads the value and records the fill; a missing field is a refusal, not a use. */
async function readValue(logins: LoginFill, target: Target) {
  const read = await logins.read(target.login.name, target.field);

  if ("missing" in read) return { refused: read.missing };

  const at = new Date().toISOString();
  const error = "unreadable" in read ? read.unreadable : null;

  await logins.recordUse(target.login.name, {
    at,
    host: target.host,
    field: target.field,
    error,
  });

  return error === null && "value" in read
    ? read
    : { refused: error ?? "unreadable" };
}

// Stored before typing: once typed, the password is on the desktop even if this job ends right after.
async function remember(state: ComputerUseState, fill: DesktopFill) {
  if (state.filled.has(fill.value) && state.browsers.has(fill.browser)) return;

  await state.fills?.add(fill);
  state.filled.set(fill.value, fill.label);
  state.browsers.add(fill.browser);
}

const UNKNOWN_CHROMIUM = "unknown";

/** The running Chromium, by pid and start time; undefined when none runs. A new one shows none of the old one's pages. */
async function chromiumInstance(state: ComputerUseState, context: Context) {
  const browser = (await listWindows(state, context)).find(isChromium);

  if (!browser) return undefined;

  const started = (
    await sh(state, `ps -o lstart= -p ${browser.pid}`, context)
  ).trim();

  return started ? `${browser.pid} ${started}` : UNKNOWN_CHROMIUM;
}

/** Whether a screenshot may show a password: one was typed into the Chromium running now, or into one we can't tell. */
export async function passwordMayShow(
  state: ComputerUseState,
  context: Context,
) {
  if (!state.browsers.size) return false;

  if (state.browsers.has(UNKNOWN_CHROMIUM)) return true;

  const current = await chromiumInstance(state, context);

  return (
    current === UNKNOWN_CHROMIUM ||
    (current !== undefined && state.browsers.has(current))
  );
}

/**
 * Types a login field into the ref's page after checking the page's host against the login's. The value never appears
 * in the result, and a password is replaced in every later result on this desktop (see `scrubFilled`).
 */
export async function fillLogin(
  state: ComputerUseState,
  args: ComputerUseArgs,
  context: Context,
): Promise<ComputerUseResult> {
  if (!state.logins) return refused("this bot has no logins here");

  const target = await targetOf(state, state.logins, args);

  if ("refused" in target) return refused(target.refused);

  const read = await readValue(state.logins, target);

  if ("refused" in read) return refused(read.refused);

  // Only a password is a secret here; usernames and one-time codes may reach the model.
  if (target.field === "password")
    await remember(state, {
      value: read.value,
      label: label(target.login.name, target.field),
      browser: (await chromiumInstance(state, context)) ?? UNKNOWN_CHROMIUM,
    });

  const { reply } = await driverCall(
    state,
    "browser_type",
    { ...target.ids, ref: target.ref, text: read.value, replace: true },
    context,
  );

  if (refusalOf(reply))
    return textResult(
      scrubText(
        state,
        `REFUSED (${codeOf(reply) ?? "refused"}): ${ourNames(messageOf(reply) ?? "")}`,
      ),
      true,
    );

  return textResult(
    `filled ${target.field.replaceAll("_", " ")} of login ${target.login.name} on ${target.host}`,
  );
}

/** A result with typed passwords replaced; captures leave out screenshots that may show one (see `passwordMayShow`). */
export function scrubFilled(
  state: ComputerUseState,
  result: ComputerUseResult,
): ComputerUseResult {
  if (!state.filled.size) return result;

  return {
    ...result,
    content: result.content.map((part) =>
      part.type === "text"
        ? { ...part, text: scrubText(state, part.text) }
        : part,
    ),
  };
}

/** Labels the passwords typed on this desktop before, once per job: Chromium outlives a job, so a page may still show one. */
export function restoreFilled(state: ComputerUseState) {
  state.restored ??= restore(state);

  return state.restored;
}

async function restore(state: ComputerUseState) {
  for (const fill of (await state.fills?.list()) ?? []) {
    state.filled.set(fill.value, fill.label);
    state.browsers.add(fill.browser);
  }
}
