import { MarkupLogo } from "@/components/brand-logo";
import { RowTile } from "@/components/page";
import type { Provider } from "./api";
import { providerLogo } from "./provider-logos";

export function ProviderTile({ provider }: { provider: Provider }) {
  const logo = providerLogo(provider.provider);

  return logo ? (
    <RowTile className="text-foreground">
      <MarkupLogo svg={logo} />
    </RowTile>
  ) : (
    <RowTile className="font-heading text-sm font-semibold text-foreground">
      {provider.name.slice(0, 1).toUpperCase()}
    </RowTile>
  );
}
