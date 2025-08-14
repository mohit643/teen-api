const express = require("express");
const fs = require("fs");
const https = require("https");
const path = require("path");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = 3000;

app.use(
  cors({
    origin:
      "https://asteritechnolo-f8ezevh0f5c4ezfv.canadacentral-01.azurewebsites.net",
  })
);
// Increase payload size limit for JSON and urlencoded
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use("/frontend", express.static(path.join(__dirname, "frontend")));

// Debug: Log environment variables (do not log secrets in production)
console.log("CLIENT_ID:", process.env.CLIENT_ID);
console.log("REDIRECT_URI:", process.env.REDIRECT_URI);
console.log("CLIENT_SECRET:", process.env.CLIENT_SECRET ? "Loaded" : "Missing");
console.log("TENANT_ID:", process.env.TENANT_ID);

// Import and use the auth router
const authRouter = require("./routes/auth");
console.log("Auth router loaded");
app.use("/", authRouter);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Also accessible via your local IP if network allows.`);
});
