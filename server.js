const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const morgan = require("morgan");
const { uuid } = require("uuidv4");
const { Client, Config, CheckoutAPI } = require("@adyen/api-library");
// init app
const app = express();
// setup request logging
app.use(morgan("dev"));
// Parse JSON bodies
app.use(express.json());
// Parse URL-encoded bodies
app.use(express.urlencoded({ extended: true }));
// Serve client from build folder
app.use(express.static(path.join(__dirname, "build")));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

// enables environment variables by
// parsing the .env file and assigning it to process.env
dotenv.config({
  path: "./.env",
});

// Adyen Node.js API library boilerplate (configuration, etc.)
const config = new Config();
config.apiKey = process.env.ADYEN_API_KEY;
const client = new Client({ config });
client.setEnvironment("TEST");
const checkout = new CheckoutAPI(client);

// in memory store for transaction
const paymentStore = {};

const determineHostUrl = (req) => {
  let {
    "x-forwarded-proto": forwardedProto,
    "x-forwarded-host": forwardedHost,
  } = req.headers;

  if (process.env.ADYEN_RETURN_URL) {
    return process.env.ADYEN_RETURN_URL;
  }

  if (forwardedProto && forwardedHost) {
    if (forwardedProto.includes(",")) {
      [forwardedProto] = forwardedProto.split(",");
    }

    return `${forwardedProto}://${forwardedHost}`;
  }

  return "http://localhost:8080";
};

/* ################# API ENDPOINTS ###################### */
app.get("/api/getPaymentDataStore", async (req, res) => res.json(paymentStore));

// Submitting a payment
app.post("/api/sessions", async (req, res) => {
  try {
    // unique ref for the transaction
    const orderRef = uuid();

    console.log("Received payment request for orderRef: " + orderRef);

    // Ideally the data passed here should be computed based on business logic
    const response = await checkout.sessions({
      countryCode: "NL",
      amount: { currency: "EUR", value: 10000 }, // value is 100€ in minor units
      reference: orderRef, // required
      merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT, // required
      returnUrl: `${determineHostUrl(req)}/redirect?orderRef=${orderRef}`, // required for 3ds2 redirect flow
    });

    // save transaction in memory
    // enable webhook to confirm the payment (change status to Authorized)
    paymentStore[orderRef] = {
      amount: { currency: "EUR", value: 1000 },
      paymentRef: orderRef,
      status: "Pending",
    };

    res.json(response);
  } catch (err) {
    console.error(`Error: ${err.message}, error code: ${err.errorCode}`);
    res.status(err.statusCode).json(err.message);
  }
});

// Cancel or Refund a payment
app.post("/api/cancelOrRefundPayment", async (req, res) => {
  console.log("/api/cancelOrRefundPayment orderRef: " + req.query.orderRef);
  // Create the payload for cancelling payment
  const payload = {
    merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT, // required
    reference: uuid(),
  };

  try {
    // Return the response back to client
    const response = await checkout.reversals(
      paymentStore[req.query.orderRef].paymentRef,
      payload
    );
    paymentStore[req.query.orderRef].status = "Refund Initiated";
    paymentStore[req.query.orderRef].modificationRef = response.pspReference;
    res.json(response);
    console.info("Refund initiated for ", response);
  } catch (err) {
    console.error(`Error: ${err.message}, error code: ${err.errorCode}`);
    res.status(err.statusCode).json(err.message);
  }
});

/* ################# end API ENDPOINTS ###################### */

/* ################# UTILS ###################### */

function findPayment(pspReference) {
  const payments = Object.values(paymentStore).filter(
    (v) => v.modificationRef === pspReference
  );
  if (payments.length < 0) {
    console.error("No payment found with that PSP reference");
  }
  return payments[0];
}

/* ################# end UTILS ###################### */

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
