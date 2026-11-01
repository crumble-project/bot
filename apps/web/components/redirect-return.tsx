import { useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  type UseNavigateResult,
} from "@tanstack/react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/** Finishes with the redirect's parameters and navigates away; rejects with the message to show. */
type Finish = (
  params: URLSearchParams,
  navigate: UseNavigateResult<string>,
) => Promise<void>;

/** A page an outside service sends the owner back to: finishes once, then navigates away or shows why it couldn't. */
export function RedirectReturn({
  finish,
  pending,
  backTo,
  backLabel,
}: {
  finish: Finish;
  pending: string;
  backTo: "/" | "/settings/integrations";
  backLabel: string;
}) {
  const navigate = useNavigate();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // StrictMode runs effects twice; a code can be exchanged only once.
    if (started.current) return;
    started.current = true;

    finish(new URLSearchParams(location.search), navigate).catch(
      (failure: Error) => setError(failure.message),
    );
  }, [finish, navigate]);

  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-4 p-6 text-center">
      {error ? (
        <>
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
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
