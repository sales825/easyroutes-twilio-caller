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
  EASYROUTES_WEBHOOK_SECRET,
  PUBLIC_BASE_URL,
  PORT = 3000,
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Verify the HMAC signature EasyRoutes sends with each webhook.
// EasyRoutes signs the raw request body with HMAC-SHA256 and sends it
// base64-encoded in the X-EasyRoutes-Hmac-SHA256 header.
function verifySignature(req) {
  if (!EASYROUTES_WEBHOOK_SECRET) {
    console.log("No webhook secret configured - skipping verification");
    return true;
  }
  const header = req.get("X-EasyRoutes-Hmac-SHA256") || "";
  if (!header || !req.rawBody) return false;

  const candidates = [EASYROUTES_WEBHOOK_SECRET];
  try { candidates.push(Buffer.from(EASYROUTES_WEBHOOK_SECRET, "base64")); } catch (e) {}

  for (const key of candidates) {
    const digest = crypto.createHmac("sha256", key).update(req.rawBody).digest("base64");
    if (digest === header) return true;
    console.log("Signature mismatch. computed=" + digest + " received=" + header);
  }
  return false;
}

function getPhone(s) {
  return (
    (s && s.contact && s.contact.phone) ||
    (s && s.phone) ||
    (s && s.customer && s.customer.phone) ||
    (s && s.address && s.address.phone) ||
    null
  );
}

const DELIVERED_STATUSES = ["DELIVERED", "ATTEMPTED", "COMPLETED", "SKIPPED"];

function status(s) {
  return (s.deliveryStatus || s.status || s.stopStatus || "").toUpperCase();
}

async function callStop(stop) {
  const phone = getPhone(stop);
  if (!phone) {
    console.log("No phone found for stop:", JSON.stringify(stop).slice(0, 400));
    return;
  }
  await twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM_NUMBER,
    url: PUBLIC_BASE_URL + "/voice",
  });
  console.log("Called next stop:", phone);
}

// Given the full route payload, find the next stop that still needs delivery
// and place the "on the way" call to that customer.
async function callNextStop(route) {
  const stops = route.stops || [];
  const next = stops.find(function (s) {
    return DELIVERED_STATUSES.indexOf(status(s)) === -1;
  });
  if (!next) {
    console.log("No remaining stops to call - route may be complete.");
    return;
  }
  console.log("Next stop up:", next.address && next.address.address1, "status:", status(next));
  await callStop(next);
}

app.get("/", function (req, res) {
  res.send("EasyRoutes to Twilio caller is running.");
});

app.post("/easyroutes-webhook", async (req, res) => {
  res.sendStatus(200);

  console.log("=== WEBHOOK RECEIVED ===");
  console.log("Topic:", req.get("X-EasyRoutes-Topic") || req.body.topic);

  if (!verifySignature(req)) {
    console.log("Signature verification FAILED - proceeding anyway (test mode)");
  }

  try {
    const event = req.body;
    const topic = event.topic || req.get("X-EasyRoutes-Topic");
    const route = event.payload || event.route || event;

    if (topic === "STOP_STATUS_UPDATED") {
      await callNextStop(route);
    } else if (topic === "ROUTE_STARTED" || topic === "ROUTE_DISPATCHED") {
      await callNextStop(route);
    } else {
      console.log("Unhandled topic:", topic);
    }
  } catch (err) {
    console.error("Error handling webhook:", err);
  }
});

// TwiML for the outbound call: what the customer hears.
app.post("/voice", function (req, res) {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { voice: "alice" },
    "Hello! This is a delivery update from T O Balloons. Your order is next on the route and the driver is on the way. Please check the tracking link we sent you by text message to see the driver's current position. Thank you!"
  );
  res.type("text/xml");
  res.send(twiml.toString());
});

app.listen(PORT, function () {
  console.log("Listening on " + PORT);
});
