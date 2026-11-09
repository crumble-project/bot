type OAuthRegistration = {
  client_id?: string;
  [key: string]: string | undefined;
};

export function gate() {
  let entered!: () => void;
  let release!: () => void;

  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    reached,
    release,
    wait: async () => {
      entered();
      await released;
    },
  };
}

type Gate = ReturnType<typeof gate>;

export function fakeAuthorizationServer({ issParameter = false } = {}) {
  const tokenRequests: URLSearchParams[] = [];
  let refreshRefused = false;
  let exchangeGate: Gate | undefined;
  let refreshGate: Gate | undefined;
  let registrationGate: Gate | undefined;
  let discoveryGate: Gate | undefined;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        await discoveryGate?.wait();

        return Response.json({
          resource: `${url.origin}/mcp`,
          authorization_servers: [url.origin],
        });
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          registration_endpoint: `${url.origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: issParameter,
        });
      }

      if (url.pathname === "/register" && request.method === "POST") {
        // SAFETY: OAuth registration requests contain a JSON object.
        const registration = (await request.json()) as OAuthRegistration;
        await registrationGate?.wait();

        return Response.json(
          { ...registration, client_id: "crumble-client" },
          { status: 201 },
        );
      }

      if (url.pathname === "/token" && request.method === "POST") {
        const params = new URLSearchParams(await request.text());
        tokenRequests.push(params);
        const number = tokenRequests.length;
        const refresh = params.get("grant_type") === "refresh_token";
        await (refresh ? refreshGate : exchangeGate)?.wait();

        if (refreshRefused && refresh)
          return Response.json({ error: "invalid_grant" }, { status: 400 });

        return Response.json({
          access_token: `access-${number}`,
          token_type: "Bearer",
          refresh_token: "refresh-1",
          expires_in: 3600,
        });
      }

      if (url.pathname === "/mcp")
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        });

      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    issuer: `http://127.0.0.1:${server.port}`,
    tokenRequests,
    refuseRefresh: () => {
      refreshRefused = true;
    },
    gateExchange: (value: Gate | undefined) => {
      exchangeGate = value;
    },
    gateRefresh: (value: Gate | undefined) => {
      refreshGate = value;
    },
    gateRegistration: (value: Gate | undefined) => {
      registrationGate = value;
    },
    gateDiscovery: (value: Gate | undefined) => {
      discoveryGate = value;
    },
    close: () => server.stop(true),
  };
}
