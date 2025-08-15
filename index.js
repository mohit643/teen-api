const express = require("express");
const fs = require("fs");
const https = require("https");
const path = require("path");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: [
      "https://remixbackend-badjarfeekbufqb3.canadacentral-01.azurewebsites.net"
    ],
  })
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use("/frontend", express.static(path.join(__dirname, "frontend")));

// Debug logs (remove in production)
console.log("CLIENT_ID:", process.env.CLIENT_ID);
console.log("REDIRECT_URI:", process.env.REDIRECT_URI);
console.log("CLIENT_SECRET:", process.env.CLIENT_SECRET ? "Loaded" : "Missing");
console.log("TENANT_ID:", process.env.TENANT_ID);

// ✅ Test API route
app.get("/test", (req, res) => {
  res.json({
    status: "success",
    message: "API is running 🚀",
    timestamp: new Date()
  });
});

const authRouter = require("./routes/auth");
app.use("/", authRouter);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
