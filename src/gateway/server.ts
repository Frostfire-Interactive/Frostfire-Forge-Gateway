import { startHttpsServers, getInternalServerOptions, serverFetch } from "../modules/https_servers";
import query from "../controllers/sqldatabase";
import player from "../systems/player";
import { brandHtmlText } from "../modules/branding";
import crypto from "crypto";
import { BlockRoutes, handleBlocks, handleRoute, liveNodesOf } from "./blockroute";

const httpPort = parseInt(process.env.GATEWAY_PORT || "9999");
const httpsPort = parseInt(process.env.GATEWAY_PORTSSL || "9443");
const internalPort = parseInt(process.env.GATEWAY_INTERNAL_PORT || "") || 9998;
// Import all types from types.d.ts

const config: GatewayConfig = {
  port: httpPort,
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || "30000"),
  serverTimeout: parseInt(process.env.SERVER_TIMEOUT || "90000"),
  sessionTimeout: parseInt(process.env.SESSION_TIMEOUT || "300000"),
  authKey: process.env.GATEWAY_AUTH_KEY || null
};

// Game servers prove themselves with this key. Without one every /register,
// /heartbeat and /unregister call would be open, so the gateway does not run.
if (typeof config.authKey !== "string" || config.authKey.trim() === "") {
  console.error("[Gateway] GATEWAY_AUTH_KEY is missing or empty. Set a strong random value in the gateway environment. Refusing to start.");
  process.exit(1);
}

// Constant-time key check. Both sides are hashed first, so keys of different
// lengths compare without throwing, and a non-string key never matches.
function isValidAuthKey(provided: unknown): boolean {
  if (typeof provided !== "string" || typeof config.authKey !== "string") return false;
  const providedDigest = crypto.createHash("sha256").update(provided).digest();
  const expectedDigest = crypto.createHash("sha256").update(config.authKey).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

const gameServers: Map<string, GameServer> = new Map();

// Cluster mode: which node of each region owns which block (POST /blocks), for GET /route. Memory only: the nodes send
// every table again when they register, so a restarted gateway learns them back.
const blockRoutes = new BlockRoutes();

// The ids of a region's nodes with a heartbeat inside the timeout: the only nodes /route may name.
function liveNodeIds(regionId: string): Set<string> {
  return liveNodesOf(gameServers.values(), regionId, Date.now(), config.serverTimeout);
}

const clientSessions: Map<string, ClientSession> = new Map();

let totalMigrations = 0;
const migrationHistory: Array<{
  timestamp: number;
  fromServer: string;
  toServer: string;
  clientCount: number;
}> = [];

// Dashboard sessions belong to an admin account that is signed in on the
// website: the gateway reads the same "token" cookie (cookies are shared across
// ports of one host) and never handles a password itself.
type DashboardSession = { username: string; expires: number; checkedAt: number };
const dashboardSessions: Map<string, DashboardSession> = new Map();
const DASHBOARD_SESSION_TIMEOUT = 3600000;
// How often a live session confirms the account is still signed in and still
// allowed, so removing the role or permission locks the dashboard promptly.
const DASHBOARD_ACCESS_RECHECK = 60000;
const DASHBOARD_PERMISSIONS = ["server.gateway", "server.*"];

function readCookie(req: Request, name: string): string | null {
  const match = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

// The account signed in on the website, or null. Guests and accounts that
// still owe a second factor do not count as signed in.
async function getSignedInAccount(req: Request): Promise<string | null> {
  const token = readCookie(req, "token");
  if (!token) return null;
  const rows = (await player.getUsernameByToken(token)) as any[];
  const username: string | undefined = rows?.[0]?.username;
  if (!username || username.startsWith("guest_")) return null;
  if (await player.isTwoFactorPending(username)) return null;
  return username;
}

// Dashboard access needs an admin account (role 1) that holds server.gateway
// or server.*, and is not banned.
async function hasDashboardAccess(username: string): Promise<boolean> {
  const accounts = (await query("SELECT role, banned FROM accounts WHERE username = ? LIMIT 1", [username])) as any[];
  if (Number(accounts?.[0]?.role) !== 1 || Number(accounts[0].banned) === 1) return false;
  const rows = (await query("SELECT permissions FROM permissions WHERE username = ? LIMIT 1", [username])) as any[];
  const held = String(rows?.[0]?.permissions || "").split(",").map((permission) => permission.trim());
  return DASHBOARD_PERMISSIONS.some((permission) => held.includes(permission));
}

async function getDashboardSession(req: Request): Promise<DashboardSession | null> {
  const sessionToken = readCookie(req, "dashboard_session");
  const session = sessionToken ? dashboardSessions.get(sessionToken) : undefined;
  if (!sessionToken || !session) return null;

  const now = Date.now();
  if (now > session.expires) {
    dashboardSessions.delete(sessionToken);
    return null;
  }

  if (now - session.checkedAt > DASHBOARD_ACCESS_RECHECK) {
    let allowed = false;
    try {
      allowed = (await getSignedInAccount(req)) === session.username && (await hasDashboardAccess(session.username));
    } catch {
      // A failed lookup closes the session rather than leaving it open unchecked.
    }
    if (!allowed) {
      dashboardSessions.delete(sessionToken);
      return null;
    }
    session.checkedAt = now;
  }

  session.expires = now + DASHBOARD_SESSION_TIMEOUT;
  return session;
}

// Where the website login page lives, on the host this request came in on.
function getWebsiteLoginUrl(req: Request): string {
  const ssl = process.env.HTTP_USE_SSL === "true";
  const port = ssl ? process.env.WEBSRV_PORTSSL || "443" : process.env.WEBSRV_PORT || "80";
  let hostname = "localhost";
  try {
    hostname = new URL(`http://${req.headers.get("host")}`).hostname || hostname;
  } catch {
    // Keep the fallback.
  }
  const defaultPort = ssl ? "443" : "80";
  return `${ssl ? "https" : "http"}://${hostname}${port === defaultPort ? "" : `:${port}`}/?next=gateway`;
}

function migrateSessionsFromDeadServer(deadServerId: string): number {
  const sessionsToMigrate: string[] = [];

  for (const [clientId, session] of clientSessions.entries()) {
    if (session.serverId === deadServerId) {
      sessionsToMigrate.push(clientId);
    }
  }

  if (sessionsToMigrate.length === 0) {
    return 0;
  }

  const healthyServers = Array.from(gameServers.values()).filter(
    server => server.activeConnections < server.maxConnections
  );

  if (healthyServers.length === 0) {
    console.warn(`[Gateway] No healthy servers available for migration from ${deadServerId}`);

    for (const clientId of sessionsToMigrate) {
      clientSessions.delete(clientId);
    }
    return 0;
  }

  console.log(`[Gateway] Migrating ${sessionsToMigrate.length} sessions from dead server ${deadServerId}`);

  let migrationIndex = 0;
  let migratedCount = 0;

  for (const clientId of sessionsToMigrate) {
    const session = clientSessions.get(clientId);
    if (!session) continue;

    const targetServer = healthyServers[migrationIndex % healthyServers.length];
    migrationIndex++;

    session.serverId = targetServer.id;
    session.lastActivity = Date.now();

    migratedCount++;
    console.log(`[Gateway] Migrated client ${clientId}: ${deadServerId} → ${targetServer.id}`);
  }

  if (migratedCount > 0) {
    healthyServers[0].id;
    migrationHistory.push({
      timestamp: Date.now(),
      fromServer: deadServerId,
      toServer: migratedCount === 1 ? healthyServers[0].id : `${healthyServers.length} servers`,
      clientCount: migratedCount
    });

    if (migrationHistory.length > 100) {
      migrationHistory.shift();
    }

    totalMigrations += migratedCount;
  }

  return migratedCount;
}

function cleanupDeadServers() {
  const now = Date.now();
  for (const [id, server] of gameServers.entries()) {
    if (now - server.lastHeartbeat > config.serverTimeout) {
      console.log(`[Gateway] Server died: ${id} (${server.host}:${server.port})`);

      const migratedCount = migrateSessionsFromDeadServer(id);

      if (migratedCount > 0) {
        console.log(`[Gateway] Successfully migrated ${migratedCount} sessions from ${id}`);
      } else {
        console.log(`[Gateway] No sessions to migrate from ${id}`);
      }

      gameServers.delete(id);
      // The last node of a region gone: its block owners are no longer true.
      blockRoutes.dropRegionIfEmpty(server.regionId, gameServers.values());
    }
  }
}

function cleanupExpiredSessions() {
  const now = Date.now();
  let removedCount = 0;

  for (const [clientId, session] of clientSessions.entries()) {
    if (now - session.lastActivity > config.sessionTimeout) {
      clientSessions.delete(clientId);
      removedCount++;
    }
  }

  if (removedCount > 0) {
    console.log(`[Gateway] Cleaned up ${removedCount} expired sessions`);
  }
}

type ServerStatus = {
  id: string;
  description: string;
  publicHost: string;
  port: number;
  wtPort?: number;
  wtEnabled: boolean;
  useSSL: boolean;
  activeConnections: number;
  maxConnections: number;
  latency: number;
  whitelisted: boolean;
  pvp: boolean;
  status: string;
  regionId?: string;
};

// The nodes of one cluster region, as /status lists them, collapsed into the one realm players see. Its host and
// ports are those of the least-loaded online node (what realm selection pings); its counts are the region's.
function collapseRegions(servers: ServerStatus[]) {
  const byRegion = new Map<string, ServerStatus[]>();
  for (const server of servers) {
    if (!server.regionId) continue;
    const nodes = byRegion.get(server.regionId);
    if (nodes) nodes.push(server);
    else byRegion.set(server.regionId, [server]);
  }

  return Array.from(byRegion.entries()).map(([regionId, nodes]) => {
    const online = nodes.filter(node => node.status === 'online');
    const pick = (online.length > 0 ? online : nodes)
      .reduce((best, node) => node.activeConnections < best.activeConnections ? node : best);
    const status = online.length > 0 ? 'online' : (nodes.some(node => node.status === 'full') ? 'full' : 'offline');
    // A node that stopped answering neither holds players nor has room for them.
    const live = nodes.filter(node => node.status !== 'offline');

    return {
      id: regionId,
      description: nodes.find(node => node.description)?.description || '',
      publicHost: pick.publicHost,
      port: pick.port,
      wtPort: pick.wtPort,
      wtEnabled: pick.wtEnabled,
      useSSL: pick.useSSL,
      activeConnections: live.reduce((sum, node) => sum + node.activeConnections, 0),
      maxConnections: live.reduce((sum, node) => sum + node.maxConnections, 0),
      latency: pick.latency,
      whitelisted: nodes.some(node => node.whitelisted),
      pvp: nodes.some(node => node.pvp),
      status,
      cluster: true
    };
  });
}

setInterval(cleanupDeadServers, config.heartbeatInterval);
setInterval(cleanupExpiredSessions, 60000);

const serverConfig: any = {
  port: internalPort,
  hostname: "127.0.0.1",
  development: false,
  ...getInternalServerOptions(
    process.env.TLS_CERT_PATH || "",
    process.env.TLS_KEY_PATH || "",
    process.env.TLS_CA_PATH
  ),
  async fetch(req: any) {
    const url = new URL(req.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (url.pathname === "/register" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, host, publicHost, port, wtPort, wtEnabled, useSSL, maxConnections, authKey, description, whitelisted, pvp, nodeId, regionId } = body;

        if (!isValidAuthKey(authKey)) {
          console.warn(`[Gateway] Registration attempt with invalid auth key from ${host}`);
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (!id || !host || !port) {
          return new Response(JSON.stringify({ error: "Missing required fields" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const existingServer = gameServers.get(id);
        const isReRegistration = !!existingServer;

        const server: GameServer = {
          id,
          description,
          host,
          publicHost: publicHost || host,
          port,
          wtPort: typeof wtPort === "number" ? wtPort : undefined,
          wtEnabled: wtEnabled === true || typeof wtPort === "number",
          useSSL: useSSL === true,
          lastHeartbeat: Date.now(),
          activeConnections: existingServer?.activeConnections || 0,
          maxConnections: maxConnections || 1000,
          whitelisted: whitelisted === true,
          pvp: pvp === true
        };
        // Sent by game servers in cluster mode only.
        if (typeof nodeId === "string" && nodeId) server.nodeId = nodeId;
        if (typeof regionId === "string" && regionId) server.regionId = regionId;

        // The first node back into a region whose other nodes are gone starts its block owners again.
        blockRoutes.dropRegionIfAlone(server.regionId, id, gameServers.values(), Date.now(), config.serverTimeout);
        gameServers.set(id, server);

        if (isReRegistration) {
          console.log(`[Gateway] Server re-registered: ${id} (${host}:${port}, https:${wtPort || "-"})`);
        } else {
          console.log(`[Gateway] Server registered: ${id} (${host}:${port}, https:${wtPort || "-"})`);
        }

        return new Response(JSON.stringify({ success: true, serverId: id }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/heartbeat" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, activeConnections, cpuUsage, ramUsage, authKey, rtt, whitelisted } = body;

        if (!isValidAuthKey(authKey)) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }

        const server = gameServers.get(id);
        if (server) {
          server.lastHeartbeat = Date.now();
          server.activeConnections = activeConnections || 0;

          if (cpuUsage !== undefined) server.cpuUsage = cpuUsage;
          if (ramUsage !== undefined) server.ramUsage = ramUsage;

          // A realm's whitelist can be switched while it runs; older game servers do not send it here.
          if (typeof whitelisted === "boolean") server.whitelisted = whitelisted;

          if (rtt !== undefined) {
            server.latency = Math.round(rtt / 2);
          }

          return new Response(JSON.stringify({
            success: true,
            timestamp: Date.now()
          }), {
            headers: { "Content-Type": "application/json" }
          });
        }

        return new Response(JSON.stringify({ error: "Server not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // A cluster node's block owners, one map at a time; same key as /heartbeat.
    if (url.pathname === "/blocks" && req.method === "POST") {
      return handleBlocks({ routes: blockRoutes, isValidAuthKey, server: (id) => gameServers.get(id) }, req);
    }

    // Which live node of a region owns a point of a map (the webserver asks, with the key in a header).
    if (url.pathname === "/route" && req.method === "GET") {
      return handleRoute({ routes: blockRoutes, isValidAuthKey, liveNodes: liveNodeIds }, req);
    }

    if (url.pathname === "/unregister" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, authKey } = body;

        if (!isValidAuthKey(authKey)) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }

        const leaving = gameServers.get(id);
        if (gameServers.delete(id)) {
          blockRoutes.dropRegionIfEmpty(leaving?.regionId, gameServers.values());
          console.log(`[Gateway] Server unregistered: ${id}`);
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" }
          });
        }

        return new Response(JSON.stringify({ error: "Server not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }


    // Who is asking, and whether they may open the dashboard. The login page
    // uses this to decide what to show.
    if (url.pathname === "/api/session" && req.method === "GET") {
      const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
      const loginUrl = getWebsiteLoginUrl(req);
      try {
        const username = await getSignedInAccount(req);
        if (!username) return new Response(JSON.stringify({ state: "signed-out", loginUrl }), { headers });
        const allowed = await hasDashboardAccess(username);
        return new Response(JSON.stringify({ state: allowed ? "allowed" : "forbidden", username, loginUrl }), { headers });
      } catch (error) {
        return new Response(JSON.stringify({ state: "error", loginUrl }), { status: 500, headers });
      }
    }

    // Opens a dashboard session for the admin signed in on the website.
    if (url.pathname === "/api/login" && req.method === "POST") {
      try {
        const username = await getSignedInAccount(req);
        if (!username) {
          return new Response(JSON.stringify({ error: "Log in on the website first" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (!(await hasDashboardAccess(username))) {
          return new Response(JSON.stringify({ error: "This account cannot open the gateway dashboard" }), {
            status: 403,
            headers: { "Content-Type": "application/json" }
          });
        }

        const sessionToken = crypto.randomUUID();
        const now = Date.now();
        dashboardSessions.set(sessionToken, { username, expires: now + DASHBOARD_SESSION_TIMEOUT, checkedAt: now });

        return new Response(JSON.stringify({ success: true, username }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": `dashboard_session=${sessionToken}; HttpOnly; Path=/; Max-Age=3600; SameSite=Strict`
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Could not check the account" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      const sessionToken = readCookie(req, "dashboard_session");
      if (sessionToken) {
        dashboardSessions.delete(sessionToken);
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "dashboard_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict"
        }
      });
    }

    if (url.pathname === "/api/stats" && req.method === "GET") {
      if (!(await getDashboardSession(req))) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }

      const servers = Array.from(gameServers.values()).map(s => ({
        id: s.id,
        description: s.description || '',
        host: s.host,
        publicHost: s.publicHost,
        port: s.port,
        activeConnections: s.activeConnections,
        maxConnections: s.maxConnections,
        lastHeartbeat: s.lastHeartbeat,
        cpuUsage: s.cpuUsage || 0,
        ramUsage: s.ramUsage || 0,
        latency: s.latency || 0,
        status: (Date.now() - s.lastHeartbeat) < config.serverTimeout ? 'healthy' : 'unhealthy'
      }));

      return new Response(JSON.stringify({
        timestamp: Date.now(),
        totalServers: gameServers.size,
        healthyServers: servers.filter(s => s.status === 'healthy').length,
        totalActiveSessions: clientSessions.size,
        totalMigrations: totalMigrations,
        recentMigrations: migrationHistory.slice(-10),
        servers
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/dashboard" && req.method === "GET") {
      if (!(await getDashboardSession(req))) {
        return Response.redirect("/", 302);
      }

      const dashboardHTML = await brandHtmlText(await Bun.file(new URL("../webserver/public/dashboard.html", import.meta.url)).text());
      return new Response(dashboardHTML, {
        headers: { "Content-Type": "text/html" }
      });
    }

    if (url.pathname === "/" && req.method === "GET") {
      const loginHTML = await brandHtmlText(await Bun.file(new URL("../webserver/public/login.html", import.meta.url)).text());
      return new Response(loginHTML, {
        headers: { "Content-Type": "text/html" }
      });
    }

    // Static file serving for CSS, JS, and other assets
    if (url.pathname.startsWith("/css/") || url.pathname.startsWith("/js/") || url.pathname.startsWith("/img/") || url.pathname.startsWith("/images/")) {
      try {
        const filePath = new URL(`../webserver/public${url.pathname}`, import.meta.url);
        const file = await Bun.file(filePath).bytes();

        let contentType = "application/octet-stream";
        if (url.pathname.endsWith(".css")) contentType = "text/css";
        else if (url.pathname.endsWith(".js")) contentType = "application/javascript";
        else if (url.pathname.endsWith(".png")) contentType = "image/png";
        else if (url.pathname.endsWith(".jpg") || url.pathname.endsWith(".jpeg")) contentType = "image/jpeg";
        else if (url.pathname.endsWith(".gif")) contentType = "image/gif";
        else if (url.pathname.endsWith(".svg")) contentType = "image/svg+xml";
        else if (url.pathname.endsWith(".ico")) contentType = "image/x-icon";
        else if (url.pathname.endsWith(".woff")) contentType = "font/woff";
        else if (url.pathname.endsWith(".woff2")) contentType = "font/woff2";
        else if (url.pathname.endsWith(".ttf")) contentType = "font/ttf";

        return new Response(file, {
          status: 200,
          headers: { "Content-Type": contentType }
        });
      } catch (error) {
        return new Response("Not found", { status: 404 });
      }
    }

    if (url.pathname === "/status" && req.method === "GET") {
      const servers = Array.from(gameServers.values()).map(s => {
        const isHealthy = (Date.now() - s.lastHeartbeat) < config.serverTimeout;
        const isFull = s.activeConnections >= s.maxConnections;

        return {
          id: s.id,
          description: s.description || '',
          publicHost: s.publicHost,
          port: s.port,
          wtPort: s.wtPort,
          wtEnabled: s.wtEnabled === true,
          useSSL: s.useSSL,
          activeConnections: s.activeConnections,
          maxConnections: s.maxConnections,
          latency: s.latency || 0,
          whitelisted: s.whitelisted || false,
          pvp: s.pvp || false,
          status: !isHealthy ? 'offline' : (isFull ? 'full' : 'online'),
          // lastHeartbeat tells the webserver when a node's player count was last refreshed.
          ...(s.nodeId ? { nodeId: s.nodeId, lastHeartbeat: s.lastHeartbeat } : {}),
          ...(s.regionId ? { regionId: s.regionId } : {})
        };
      });

      const regions = collapseRegions(servers);

      return new Response(JSON.stringify({
        totalServers: gameServers.size,
        servers,
        // Only when a cluster region is registered, so /status reads as it always did without one.
        ...(regions.length > 0 ? { regions } : {})
      }), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }

    // Every /debug route needs the same signed-in dashboard session as /api/stats.
    if (url.pathname === "/debug" || url.pathname.startsWith("/debug/")) {
      if (!(await getDashboardSession(req))) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/debug/sessions" && req.method === "GET") {
      const sessions = Array.from(clientSessions.entries()).map(([clientId, session]) => ({
        clientId,
        serverId: session.serverId,
        lastActivity: new Date(session.lastActivity).toISOString(),
        age: Math.floor((Date.now() - session.lastActivity) / 1000) + 's'
      }));

      return new Response(JSON.stringify({
        totalSessions: clientSessions.size,
        sessions: sessions
      }, null, 2), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }

    const gatewayRoutes = ['/register', '/heartbeat', '/unregister', '/blocks', '/route', '/status', '/debug', '/api', '/dashboard'];
    const webRoutes = ['/','/login','/logout'];
    const isGatewayRoute = gatewayRoutes.some(route => url.pathname.startsWith(route)) || url.pathname === '/';
    const isWebRoute = webRoutes.some(route => url.pathname === route);

    if (!isGatewayRoute && !isWebRoute) {
      const availableServers = Array.from(gameServers.values());
      if (availableServers.length === 0) {
        return new Response("No game servers available", { status: 503 });
      }

      const cookies = req.headers.get('cookie') || '';
      const httpSessionMatch = cookies.match(/gateway_http_session=([^;]+)/);
      let targetServer: GameServer | null = null;
      let httpSessionId: string | null = null;
      let isNewSession = false;

      if (httpSessionMatch) {
        httpSessionId = httpSessionMatch[1] as string;

        const session = clientSessions.get(httpSessionId);
        if (session) {
          targetServer = gameServers.get(session.serverId) || null;
        }
      }

      if (!targetServer) {
        targetServer = availableServers[Math.floor(Math.random() * availableServers.length)];

        httpSessionId = `http-${crypto.randomUUID()}`;
        clientSessions.set(httpSessionId, {
          serverId: targetServer.id,
          lastActivity: Date.now(),
          clientId: httpSessionId
        });

        isNewSession = true;
      }

      const targetProtocol = targetServer.useSSL ? "https" : "http";
      const targetUrl = `${targetProtocol}://${targetServer.host}:${targetServer.port}${url.pathname}${url.search}`;

      try {

        const proxyResponse = await serverFetch(targetUrl, {
          method: req.method,
          headers: req.headers,
          body: req.body
        });

        const responseHeaders = new Headers(proxyResponse.headers);

        if (isNewSession && httpSessionId) {
          responseHeaders.set('Set-Cookie', `gateway_http_session=${httpSessionId}; Path=/; Max-Age=3600; SameSite=Lax; HttpOnly`);
        }

        return new Response(proxyResponse.body, {
          status: proxyResponse.status,
          headers: responseHeaders
        });
      } catch (error) {
        return new Response("Failed to fetch resource", { status: 502 });
      }
    }

    return new Response("Gateway Load Balancer", { status: 200 });
  }
};

Bun.serve(serverConfig);

const stack = startHttpsServers({
  name: "Gateway",
  sslEnabled: process.env.HTTP_USE_SSL === "true",
  httpPort,
  httpsPort,
  internalPort,
  certPath: process.env.TLS_CERT_PATH,
  keyPath: process.env.TLS_KEY_PATH,
  caPath: process.env.TLS_CA_PATH,
});

const protocol = stack.sslEnabled ? 'https' : 'http';
console.log(`[Gateway] Gateway Server running on ${protocol}://localhost:${stack.publicPort}`);
console.log(`[Gateway] Waiting for game servers to register...`);

export {}