// server.js
const express = require("express");
const crypto = require("crypto");
const twilio = require("twilio");

const app = express();

// Capture the raw body so we can verify the webhook signature.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Twilio posts form-encoded bodies (needed to read Digits from the keypad).
app.use(express.urlencoded({ extended: false }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  EASYROUTES_WEBHOOK_SECRET,
  PUBLIC_BASE_URL,
  TEAM_PHONE,
  PORT = 3000,
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// The voice used for the outbound call. Google neural voice = modern, natural.
// Fallbacks if unavailable on the account: "Polly.Joanna-Neural" or "alice".
const CALL_VOICE = "Google.en-US-Neural2-F";
const CALL_LANGUAGE = "en-US";

// --- Anti-spam guards ------------------------------------------------------
// Previously, every webhook (including EasyRoutes retries) re-called whoever
// was currently the "next" stop, so one customer received 18 calls in about
// 10 seconds. These guards make each stop callable exactly once.

// Stop identifiers we have already placed a call for.
const calledStops = new Set();
// Phone number -> timestamp (ms) of the last call we placed to it.
const recentlyCalled = new Map();
// Never call the same number twice inside this window.
const COOLDOWN_MS = 10 * 60 * 1000;
// Webhook delivery IDs we have already processed (retry protection).
const seenDeliveries = new Set();

function stopId(s) {
  return (
    s.id ||
    s.stopId ||
    s._id ||
    s.orderId ||
    getPhone(s) ||
    JSON.stringify(s).slice(0, 80)
  );
}

// Keep the in-memory maps from growing without bound.
function prune() {
  const cutoff = Date.now() - COOLDOWN_MS;
  for (const [phone, ts] of recentlyCalled) {
    if (ts < cutoff) recentlyCalled.delete(phone);
  }
  if (calledStops.size > 5000) calledStops.clear();
  if (seenDeliveries.size > 5000) seenDeliveries.clear();
}

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

  const id = stopId(stop);
  if (calledStops.has(id)) {
    console.log("Already called this stop, skipping:", id);
    return;
  }

  const last = recentlyCalled.get(phone);
  if (last && Date.now() - last < COOLDOWN_MS) {
    console.log("Number called too recently, skipping:", phone);
    return;
  }

  // Reserve BEFORE awaiting so overlapping webhooks cannot slip through.
  calledStops.add(id);
  recentlyCalled.set(phone, Date.now());

  try {
    await twilioClient.calls.create({
      to: phone,
      from: TWILIO_FROM_NUMBER,
      url: PUBLIC_BASE_URL + "/voice",
    });
    console.log("Called next stop:", phone);
  } catch (err) {
    // Release the reservation so a genuine failure can be retried later.
    calledStops.delete(id);
    recentlyCalled.delete(phone);
    console.error("Twilio call failed for", phone, err && err.message);
  }
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
  // Acknowledge immediately so EasyRoutes does not retry the delivery.
  res.sendStatus(200);

  console.log("=== WEBHOOK RECEIVED ===");
  const topic = req.get("X-EasyRoutes-Topic") || (req.body && req.body.topic);
  console.log("Topic:", topic);

  if (!verifySignature(req)) {
    // Still non-blocking. Change this to a return once you have confirmed
    // in the Render logs that signatures validate correctly.
    console.log("Signature verification FAILED - proceeding anyway (test mode)");
  }

  // Drop duplicate deliveries of the same webhook.
  const deliveryId =
    req.get("X-EasyRoutes-Delivery-Id") || req.get("X-Shopify-Webhook-Id");
  if (deliveryId) {
    if (seenDeliveries.has(deliveryId)) {
      console.log("Duplicate webhook delivery, ignoring:", deliveryId);
      return;
    }
    seenDeliveries.add(deliveryId);
  }

  prune();

  try {
    const event = req.body;
    const route = event.payload || event.route || event;

    if (
      topic === "STOP_STATUS_UPDATED" ||
      topic === "ROUTE_STARTED" ||
      topic === "ROUTE_DISPATCHED"
    ) {
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

  // Give the customer a chance to press 1 and be patched through to our team.
  const gather = twiml.gather({
    numDigits: 1,
    timeout: 6,
    action: "/keypress",
    method: "POST",
  });

  gather.say(
    { voice: CALL_VOICE, language: CALL_LANGUAGE },
    "Hello! This is a delivery update from T O Balloons. Your order is next on the route and the driver is on the way. Please check the tracking link we sent you by text message to see the driver's current position. If you would like to speak with a member of our team, press 1 now. Otherwise, we hope you love your balloons and have a very happy day!"
  );

  // Nothing pressed before the gather timed out: say goodbye and hang up.
  twiml.say(
    { voice: CALL_VOICE, language: CALL_LANGUAGE },
    "Thank you, and have a wonderful day. Goodbye!"
  );
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// The customer pressed a key during the delivery call.
app.post("/keypress", function (req, res) {
  const twiml = new twilio.twiml.VoiceResponse();
  const digits = (req.body && req.body.Digits) || "";
  const customer = (req.body && req.body.To) || "unknown";

  if (digits === "1") {
    if (!TEAM_PHONE) {
      console.error("Customer " + customer + " pressed 1 but TEAM_PHONE is not set.");
      twiml.say(
        { voice: CALL_VOICE, language: CALL_LANGUAGE },
        "Sorry, we are not able to connect you right now. Please reply to the text message we sent you and we will get right back to you. Goodbye!"
      );
    } else {
      console.log("Customer " + customer + " pressed 1 - connecting to the team line.");
      twiml.say(
        { voice: CALL_VOICE, language: CALL_LANGUAGE },
        "Connecting you to a member of our team now. Please hold."
      );

      const dial = twiml.dial({
        callerId: TWILIO_FROM_NUMBER,
        timeout: 25,
        answerOnBridge: true,
      });
      dial.number(TEAM_PHONE);

      // Only reached if nobody answered or the call ended.
      twiml.say(
        { voice: CALL_VOICE, language: CALL_LANGUAGE },
        "Sorry, nobody is available to take your call right now. Please reply to the text message we sent you and we will get right back to you. Goodbye!"
      );
    }
  } else {
    twiml.say(
      { voice: CALL_VOICE, language: CALL_LANGUAGE },
      "Thank you, and have a wonderful day. Goodbye!"
    );
  }

  twiml.hangup();
  res.type("text/xml");
  res.send(twiml.toString());
});

app.listen(PORT, function () {
  console.log("Listening on " + PORT);
});
