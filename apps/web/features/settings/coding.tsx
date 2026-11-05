import { useQuery } from "@tanstack/react-query";
import { Page } from "@/components/page";
import {
  githubAccountsQuery,
  githubAppsQuery,
  refreshGithub,
} from "@/features/github-apps/api";
import {
  AccountsSection,
  AppsSection,
} from "@/features/github-apps/github-apps";
import { WorkspaceSettings } from "@/features/workspaces/workspace-settings";

/** What the account's coding jobs work with: for now, the GitHub identities bots act as. */
export function CodingPage() {
  const apps = useQuery(githubAppsQuery);
  const accounts = useQuery(githubAccountsQuery);

  return (
    <Page
      title="Coding"
      onRefresh={() => void refreshGithub()}
      refreshing={apps.isFetching || accounts.isFetching}
    >
      <WorkspaceSettings />
      <AppsSection />
      <AccountsSection />
    </Page>
  );
}
