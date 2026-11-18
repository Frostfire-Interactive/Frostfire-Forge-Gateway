// Routes only a full account may use. A guest account has no e-mail or password of its own and is removed a day after
// its last login, so it has no profile to manage: a profile route answers a guest 403 with `guest: true`, and the
// profile page shows that instead of the profile.

type Route = (req: Request) => Response | Promise<Response>;

export function accountsOnly(route: Route, isGuest: (req: Request) => Promise<boolean>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (await isGuest(req)) {
      return new Response(JSON.stringify({ guest: true, message: "Guest accounts have no profile" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    return route(req);
  };
}
