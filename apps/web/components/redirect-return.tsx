import { useQuery } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  type UseNavigateResult,
} from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ErrorAlert } from "@/components/page";
import { Spinner } from "@/components/ui/spinner";

type Finish = (
  params: URLSearchParams,
  navigate: UseNavigateResult<string>,
) => Promise<void>;

export function RedirectReturn({
  finish,
  pending,
  backTo,
  backLabel,
}: {
  finish: Finish;
  pending: string;
  backTo: "/settings/integrations" | "/settings/coding";
  backLabel: string;
}) {
  const navigate = useNavigate();

  // A query, not an effect: its cache runs the exchange once per redirect, also under StrictMode, since a code works once.
  const done = useQuery({
    queryKey: ["redirect-return", location.pathname, location.search],
    queryFn: () =>
      finish(new URLSearchParams(location.search), navigate).then(() => null),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const error = done.error?.message;

  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-4 p-6 text-center">
      {error ? (
        <>
          <ErrorAlert>{error}</ErrorAlert>
          <Button
            variant="outline"
            render={<Link to={backTo} />}
            nativeButton={false}
          >
            {backLabel}
          </Button>
        </>
      ) : (
        <>
          <Spinner />
          <p className="text-sm text-muted-foreground">{pending}</p>
        </>
      )}
    </div>
  );
}
