import "dotenv/config";
import { createServer } from "node:http";
import { google } from "googleapis";

/**
 * One-time helper: mints a Google Calendar refresh token via the OAuth
 * "installed app" (loopback) flow.
 *
 *   1. Create an OAuth 2.0 Client ID (type: Desktop app) in Google Cloud
 *      Console and enable the Google Calendar API.
 *   2. export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...  (or put in .env)
 *   3. pnpm auth:google
 *   4. Approve in the browser; the refresh token prints here. Paste it into
 *      .env as GOOGLE_REFRESH_TOKEN.
 */

const PORT = 4567;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (in .env or the shell) first."
  );
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force a refresh_token even on re-auth
  scope: SCOPES,
});

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/oauth2callback")) {
    res.writeHead(404).end();
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");

  if (err || !code) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end(`Authorization failed: ${err ?? "no code returned"}`);
    console.error(`Authorization failed: ${err ?? "no code"}`);
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      "<h2>✅ Authorized.</h2><p>You can close this tab and return to the terminal.</p>"
    );

    console.log("\n──────────────────────────────────────────────");
    if (tokens.refresh_token) {
      console.log("Add this to your .env:\n");
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    } else {
      console.log(
        "No refresh_token returned. Revoke prior access at\n" +
          "https://myaccount.google.com/permissions and re-run."
      );
    }
    console.log("──────────────────────────────────────────────\n");
  } catch (e) {
    res.writeHead(500).end("Token exchange failed");
    console.error("Token exchange failed:", e);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 200);
  }
});

server.listen(PORT, () => {
  console.log(`\nOpen this URL in your browser to authorize:\n\n${authUrl}\n`);
  console.log(`(Listening on ${REDIRECT_URI} for the redirect...)`);
});
