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
