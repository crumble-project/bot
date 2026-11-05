/** How a bot commits in one GitHub account's repositories, or in every other one for a machine account (`account`
 * null); `trailer` marks commits made as the owner. */
export type GitHubIdentity = {
  account: string | null;
  name: string;
  email: string;
  trailer?: string | undefined;
};

/** The bots an assignment adds and takes off, from the identity's current bots and the requested ones. */
export const assignmentChange = (
  previous: readonly string[],
  botIds: readonly string[],
) => ({
  added: botIds.filter((botId) => !previous.includes(botId)),
  removed: previous.filter((botId) => !botIds.includes(botId)),
});

/** What the bot and its coding jobs read about how they act on GitHub, default identity first. */
export const githubIdentityLines = (identities: readonly GitHubIdentity[]) => {
  const [fallback, ...others] = identities;

  if (!fallback) return [];

  const reach = identities.map((each) =>
    each.account === null
      ? `every other repository ${each.name} can reach`
      : each.account,
  );

  return [
    `On GitHub you are ${fallback.name}: commits default to that author, and GH_TOKEN signs git and gh in for ${reach.join(", ")}.`,
    ...others.map(
      (each) =>
        `In a repository owned by ${each.account}, first run: git config user.name '${each.name}' && git config user.email '${each.email}'`,
    ),
    ...(others.length
      ? [
          `gh pr and other GraphQL commands use ${fallback.name}'s token; in ${others.map((each) => `${each.account}'s`).join(", ")} repositories use REST, such as gh api repos/OWNER/REPO/pulls -f title=... -f head=... -f base=...`,
        ]
      : []),
    ...identities.flatMap((each) =>
      each.trailer
        ? [
            `${each.name} is the owner's own account, which you act as in ${each.account}'s repositories: keep ${each.name} as the commit author, even if a task names an App's [bot] user, and mark your work instead: every commit there ends with the trailer "${each.trailer}". Repositories you clone add it on their own unless they set core.hooksPath; there, and in older clones, pass git commit --trailer '${each.trailer}'.`,
          ]
        : [],
    ),
  ];
};
