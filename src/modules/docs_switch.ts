// Read once, when the process starts.
export const DOCS_ENABLED = process.env.DOCS_ENABLED !== "false";

// The paths that are the documentation site.
export function isDocsPath(pathname: string): boolean {
  return pathname === "/docs" || pathname.startsWith("/docs/") || pathname === "/api/docs";
}

export function docsNotFound(): Response {
  return new Response(JSON.stringify({ message: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
}

// Takes every link to /docs out of an HTML response.
export function withoutDocsLinks(source: Response): Response {
  return new HTMLRewriter()
    .on('a[href="/docs"]', {
      element(el) {
        el.remove();
      },
    })
    .transform(source);
}
