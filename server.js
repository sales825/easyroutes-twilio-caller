// server.js
const express = require("express");
const crypto = require("crypto");
const twilio = require("twilio");

const app = express();

// Capture the raw body so we can verify the webhook signature.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  EASYROUTES_CLIENT_ID,
  EASYROUTES_SECRET_KEY,
  EASYROUTES_WEBHOOK_SECRET,
  PUBLIC_BASE_URL,
  PORT = 3000,
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Verify the HMAC signature EasyRoutes sends with each webhook.
function verifySignature(req) {
  if (!EASYROUTES_WEBHOOK_SECRET) return true; // skip if not configured yet
  const header =
    req.get("X-EasyRoutes-Hmac-SHA256") ||
    req.get("X-Hmac-SHA256") ||
    req.get("X-Webhook-Signature") ||
    "";
  if (!header || !req.rawBody) return false;
  const digest = crypto
    .createHmac("sha256", EASYROUTES_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(header));
  } catch {
    return false;
  }
}

async function getEasyRoutesToken() {
  const res = await fetch("https://api.easyroutes.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: EASYROUTES_CLIENT_ID,
      client_secret: EASYROUTES_SECRET_KEY,
    }),
  });
  return (await res.json()).access_token;
}

async function getRoute(routeId, token) {
  const res = await fetch(`https://api.easyroutes.com/routes/${routeId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

function isDeliveryStop(s) {
  const type = (s.type || s.stopType || "delivery").toLowerCase();
  return type === "delivery";
}

function getPhone(s) {
  return (
    s.phone ||
    s.customer?.phone ||
    s.address?.phone ||
    s.contact?.phone ||
    s.shippingAddress?.phone ||
    null
  );
}

async function callStop(stop) {
  const phone = getPhone(stop);
  if (!phone) {
    console.log("No phone found for stop:", JSON.stringify(stop).slice(0, 500));
    return;
  }
  await twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM_NUMBER,
    url: `${PUBLIC_BASE_URL}/voice`,
  });
  console.log("Called next stop:", phone);
}

app.post("/easyroutes-webhook", async (req, res) => {
  res.sendStatus(200);

  // ---- TEST DIAGNOSTICS: log exactly what EasyRoutes sends ----
  console.log("=== WEBHOOK RECEIVED ===");
  console.log("Headers:", JSON.stringify(req.headers));
  console.log("Body:", JSON.stringify(req.body));

  if (!verifySignature(req)) {
    console.log("Signature verification FAILED - ignoring webhook");
    return;
  }

  try {
    const event = req.body;
    const topic = event.topic || event.event || event.type;
    const token = await getEasyRoutesToken();

    if (topic === "ROUTE_STARTED" || topic === "ROUTE_DISPATCHED") {
      const routeId = event.route?.id || event.routeId || event.data?.routeId;
      const route = await getRoute(routeId, token);
      console.log("Route structure sample:", JSON.stringify(route).slice(0, 800));
      const first = (route.stops || []).find(isDeliveryStop);
      if (first) await callStop(first);
      return;
    }

    const stop = event.stop || event.data || {};
    const status = (stop.status || stop.stopStatus || "").toLowerCase();
    console.log("Stop status:", status);
    if (status !== "completed") return;

    const routeId = stop.routeId || event.routeId || stop.route?.id;
    const route = await getRoute(routeId, token);
    console.log("Route structure sample:", JSON.stringify(route).slice(0, 800));
    const stops = route.stops || [];
    const idx = stops.findIndex((s) => s.id === stop.id);
    const next = stops
      .slice(idx + 1)
      .find((s) => isDeliveryStop(s) && (s.status || "").toLowerCase() !== "completed");

    if (next) await callStop(next);
    else console.log("No next stop to call.");
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { voice: "alice" },
    "Hello, this is a delivery update from T O Balloons. " +
    "Your order is next and your driver is on the way to you now. " +
    "Please have someone available to receive your delivery. Thank you!"
  );
  res.type("text/xml").send(twiml.toString());
});

app.get("/", (req, res) => res.send("EasyRoutes Twilio caller is running."));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
