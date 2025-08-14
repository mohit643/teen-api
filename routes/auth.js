const express = require("express");
const axios = require("axios");
const qs = require("qs");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { BlobServiceClient } = require("@azure/storage-blob");

const router = express.Router();

const {
  CLIENT_ID,
  REDIRECT_URI,
  CLIENT_SECRET,
  TENANT_ID,
  AZURE_STORAGE_ACCOUNT,
  AZURE_BLOB_CONTAINER,
  AZURE_SAS_TOKEN,
} = process.env;

// Debug: Log environment variables (do not log secrets in production)
console.log("AUTH ROUTER ENV CHECK:");
console.log("CLIENT_ID:", CLIENT_ID);
console.log("REDIRECT_URI:", REDIRECT_URI);
console.log("CLIENT_SECRET:", CLIENT_SECRET ? "Loaded" : "Missing");
console.log("TENANT_ID:", TENANT_ID);

// Set up storage for PDFs
const pdfStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, "../uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});
const upload = multer({ storage: pdfStorage });

// Helper to sanitize Azure blob tag values (Azure has strict validation)
function sanitizeTagValue(value) {
  if (!value || typeof value !== "string") return "";

  // Azure blob tag restrictions:
  // - Max 256 characters
  // - Only alphanumeric, space, and these special chars: + - . / : = _
  // - No leading/trailing spaces

  return value
    .substring(0, 256) // Limit length
    .replace(/[^a-zA-Z0-9\s+\-./:=_]/g, "") // Remove invalid characters
    .trim(); // Remove leading/trailing spaces
}

// Helper to get BlobServiceClient using SAS token
function getBlobServiceClientWithSAS() {
  const sasUrl = `https://${AZURE_STORAGE_ACCOUNT}.blob.core.windows.net/?${AZURE_SAS_TOKEN}`;
  return new BlobServiceClient(sasUrl);
}

// Helper to upload file buffer to Azure Blob Storage using SAS with metadata
async function uploadPdfToAzureWithSAS(
  userEmail,
  file,
  metadata = {},
  filenameOverride
) {
  try {
    const blobServiceClient = getBlobServiceClientWithSAS();
    const containerClient =
      blobServiceClient.getContainerClient(AZURE_BLOB_CONTAINER);

    // Ensure container exists (optional, but good for debugging)
    if (!(await containerClient.exists())) {
      throw new Error(
        `Azure Blob container "${AZURE_BLOB_CONTAINER}" does not exist.`
      );
    }

    const blobName =
      filenameOverride || `${userEmail}/${Date.now()}-${file.originalname}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Upload the file
    await blockBlobClient.uploadData(file.buffer, {
      blobHTTPHeaders: { blobContentType: file.mimetype },
    });

    // Set metadata as blob tags (Azure has strict validation rules)
    const tags = {
      email: sanitizeTagValue(userEmail),
      description: sanitizeTagValue(metadata.description || ""),
      status: sanitizeTagValue(metadata.status || ""),
      bolt_hole_size: sanitizeTagValue(metadata.bolt_hole_size || ""),
      bolt_pattern: sanitizeTagValue(metadata.bolt_pattern || ""),
      bolt_circle_diameter: sanitizeTagValue(
        metadata.bolt_circle_diameter || ""
      ),
      bolt_hole_style: sanitizeTagValue(metadata.bolt_hole_style || ""),
      uploadedAt: new Date().toISOString().replace(/[^0-9T:-]/g, ""), // Remove invalid chars
    };

    // Remove empty tags
    Object.keys(tags).forEach((key) => {
      if (!tags[key] || tags[key].length === 0) delete tags[key];
    });

    console.log("Setting Azure blob tags:", tags);
    await blockBlobClient.setTags(tags);
    console.log(`Uploaded PDF with metadata: ${blobName}`);

    return blockBlobClient.url;
  } catch (err) {
    console.error("Azure Blob upload error (detailed):", err);
    throw err;
  }
}

// Azure Blob Storage metadata functions (replaces local JSON storage)
async function getAllPdfsFromAzure() {
  try {
    const blobServiceClient = getBlobServiceClientWithSAS();
    const containerClient =
      blobServiceClient.getContainerClient(AZURE_BLOB_CONTAINER);

    const pdfs = [];

    // List all blobs in the container
    for await (const blob of containerClient.listBlobsFlat({
      includeMetadata: true,
      includeTags: true,
    })) {
      try {
        const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
        const blobUrl = blockBlobClient.url;

        // Get blob tags (metadata)
        const tagsResponse = await blockBlobClient.getTags();
        const tags = tagsResponse.tags || {};

        // Extract email from blob path or tags
        const email =
          tags.email || blob.name.split("/")[0]?.replace("%40", "@") || "";

        const pdfData = {
          filename: blob.name.split("/").pop() || blob.name,
          blobUrl: blobUrl,
          email: email,
          description: tags.description || "",
          status: tags.status || "",
          bolt_hole_size: tags.bolt_hole_size || "",
          bolt_pattern: tags.bolt_pattern || "",
          bolt_circle_diameter: tags.bolt_circle_diameter || "",
          bolt_hole_style: tags.bolt_hole_style || "",
          uploadedAt:
            tags.uploadedAt ||
            blob.properties.lastModified?.toISOString() ||
            new Date().toISOString(),
          otherInfo: {},
        };

        pdfs.push(pdfData);
      } catch (blobError) {
        console.error(`Error processing blob ${blob.name}:`, blobError.message);
        // Continue with other blobs
      }
    }

    console.log(`Retrieved ${pdfs.length} PDFs from Azure`);
    return pdfs;
  } catch (err) {
    console.error("Error getting PDFs from Azure:", err);
    throw err;
  }
}

async function updatePdfMetadataInAzure(blobUrl, metadata) {
  try {
    const url = new URL(blobUrl);
    const blobName = decodeURIComponent(
      url.pathname.replace(`/${AZURE_BLOB_CONTAINER}/`, "")
    );

    const blobServiceClient = getBlobServiceClientWithSAS();
    const containerClient =
      blobServiceClient.getContainerClient(AZURE_BLOB_CONTAINER);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Convert metadata to tags (Azure tags have limitations)
    const tags = {
      email: sanitizeTagValue(metadata.email || ""),
      description: sanitizeTagValue(metadata.description || ""),
      status: sanitizeTagValue(metadata.status || ""),
      bolt_hole_size: sanitizeTagValue(metadata.bolt_hole_size || ""),
      bolt_pattern: sanitizeTagValue(metadata.bolt_pattern || ""),
      bolt_circle_diameter: sanitizeTagValue(
        metadata.bolt_circle_diameter || ""
      ),
      bolt_hole_style: sanitizeTagValue(metadata.bolt_hole_style || ""),
      uploadedAt: (metadata.uploadedAt || new Date().toISOString()).replace(
        /[^0-9T:-]/g,
        ""
      ),
    };

    // Remove empty tags
    Object.keys(tags).forEach((key) => {
      if (!tags[key] || tags[key].length === 0) delete tags[key];
    });

    console.log("Updating Azure blob tags:", tags);
    await blockBlobClient.setTags(tags);
    console.log(`Updated metadata for blob: ${blobName}`);
    return true;
  } catch (err) {
    console.error("Error updating PDF metadata in Azure:", err);
    throw err;
  }
}

// Ensure all fields are present when uploading or updating PDF metadata

function ensurePdfFields(pdf) {
  return {
    filename: pdf.filename || "",
    blobUrl: pdf.blobUrl || "",
    email: pdf.email || pdf.user || "",
    description: pdf.description || "",
    status: pdf.status || "",
    bolt_hole_size: pdf.bolt_hole_size || "",
    bolt_pattern: pdf.bolt_pattern || "",
    bolt_circle_diameter: pdf.bolt_circle_diameter || "",
    bolt_hole_style: pdf.bolt_hole_style || "",
    otherInfo: pdf.otherInfo || {},
    uploadedAt: pdf.uploadedAt || new Date().toISOString(),
  };
}

// === Step 1: Redirect user to Microsoft login ===
router.get("/login", (req, res) => {
  console.log("GET /login endpoint hit");
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    response_mode: "query",
    scope: "user.read",
  });

  const authUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?${params}`;
  console.log(authUrl, "lllllllllllll");
  res.redirect(authUrl);
});

// === Step 2: Microsoft redirects here with a code ===
router.get("/auth/redirect", async (req, res) => {
  const code = req.query.code;

  try {
    const tokenResponse = await axios.post(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
      qs.stringify({
        client_id: CLIENT_ID,
        scope: "user.read",
        code: code,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
        // client_secret: CLIENT_SECRET,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token } = tokenResponse.data;

    const userResponse = await axios.get(
      "https://graph.microsoft.com/v1.0/me",
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );

    // Redirect to frontend home page with user info as query param
    const userStr = encodeURIComponent(JSON.stringify(userResponse.data));
    res.redirect(
      `https://remixfrontend-brbnd3hvaudwc0dw.canadacentral-01.azurewebsites.net/dashboard?user=${userStr}`
    );
  } catch (err) {
    console.error(
      "Error during token exchange or user fetch",
      err.response?.data || err.message
    );
    res.status(500).send("Authentication failed");
  }
});

// === New: Login with email and password using ROPC flow ===
router.post("/login", async (req, res) => {
  console.log("POST /login endpoint hit", req.body);
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const tokenResponse = await axios.post(
      `https://login.microsoftonline.com/organizations/oauth2/v2.0/token`,
      qs.stringify({
        client_id: CLIENT_ID,
        scope: "user.read",
        username: email,
        password: password,
        grant_type: "password",
        client_secret: CLIENT_SECRET,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token } = tokenResponse.data;
    console.log("Access token received:", access_token);

    const userResponse = await axios.get(
      "https://graph.microsoft.com/v1.0/me",
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );

    res.json({
      message: "Login successful",
      user: userResponse.data,
    });
  } catch (err) {
    console.error("Azure AD login error", err.response?.data || err.message);
    res
      .status(401)
      .json({ error: "Invalid credentials or authentication failed" });
  }
});

// === User login with email (userPrincipalName) and password using ROPC flow ===
router.post("/user-login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const tokenResponse = await axios.post(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
      qs.stringify({
        client_id: CLIENT_ID,
        scope: "user.read",
        username: email, // userPrincipalName from your user list
        password: password,
        grant_type: "password",
        client_secret: CLIENT_SECRET,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token } = tokenResponse.data;

    // Fetch user profile using access_token
    const userResponse = await axios.get(
      "https://graph.microsoft.com/v1.0/me",
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );

    res.json({
      message: "Login successful",
      user: userResponse.data,
      access_token,
    });
  } catch (err) {
    console.error("User login error", err.response?.data || err.message);
    res
      .status(401)
      .json({ error: "Invalid credentials or authentication failed" });
  }
});

// === Get all users in the tenant using client credentials flow (Application permissions required) ===
router.get("/all-users", async (req, res) => {
  try {
    // Get access token using client credentials flow
    const tokenResponse = await axios.post(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
      qs.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token } = tokenResponse.data;

    // Request more user fields and memberships
    const usersResponse = await axios.get(
      "https://graph.microsoft.com/v1.0/users?$select=displayName,givenName,surname,mail,userPrincipalName,id,jobTitle,mobilePhone,officeLocation,preferredLanguage,department,accountEnabled,createdDateTime",
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );

    // Optionally, fetch roles for each user (requires Directory.Read.All)
    // Example: Get directory roles and members
    const rolesResponse = await axios.get(
      "https://graph.microsoft.com/v1.0/directoryRoles?$expand=members",
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );

    // Optionally, fetch group memberships for each user (requires GroupMember.Read.All)
    // Example: Get groups for all users (first page)
    const groupsResponse = await axios.get(
      "https://graph.microsoft.com/v1.0/groups?$expand=members",
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );

    res.json({
      users: usersResponse.data.value,
      roles: rolesResponse.data.value,
      groups: groupsResponse.data.value,
    });
  } catch (err) {
    console.error(
      "Azure AD all users/roles/groups fetch error",
      err.response?.data || err.message
    );
    res
      .status(401)
      .json({ error: "Failed to fetch users or insufficient permissions" });
  }
});

// Local PDF upload endpoint removed - using Azure-only approach

const azureUpload = multer({ storage: multer.memoryStorage() });

// --- Upload PDF to Azure Blob Storage, user-wise, using SAS token ===
router.post(
  "/upload-pdf-azure",
  azureUpload.single("pdf"),
  async (req, res) => {
    const {
      email,
      description,
      status,
      bolt_hole_size,
      bolt_pattern,
      bolt_circle_diameter,
      bolt_hole_style,
      ...otherInfo
    } = req.body;
    if (!email) {
      return res.status(400).json({ error: "User email is required" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "PDF file is required" });
    }

    try {
      // Prepare metadata
      const metadata = {
        description,
        status,
        bolt_hole_size,
        bolt_pattern,
        bolt_circle_diameter,
        bolt_hole_style,
        ...otherInfo,
      };

      const blobUrl = await uploadPdfToAzureWithSAS(email, req.file, metadata);

      // Return the PDF entry structure for consistency
      const pdfEntry = {
        filename: req.file.originalname,
        blobUrl,
        email,
        description: description || "",
        status: status || "",
        bolt_hole_size: bolt_hole_size || "",
        bolt_pattern: bolt_pattern || "",
        bolt_circle_diameter: bolt_circle_diameter || "",
        bolt_hole_style: bolt_hole_style || "",
        otherInfo: otherInfo || {},
        uploadedAt: new Date().toISOString(),
      };

      res.json({
        message: "PDF uploaded to Azure successfully",
        blobUrl,
        pdf: pdfEntry,
      });
    } catch (err) {
      console.error("Azure Blob upload error", err.message, err);
      res
        .status(500)
        .json({ error: "Failed to upload PDF to Azure", details: err.message });
    }
  }
);

// === Get all PDFs from Azure (replaces local JSON) ===
router.get("/all-pdfs-azure", async (req, res) => {
  try {
    console.log("Fetching all PDFs from Azure...");
    const pdfs = await getAllPdfsFromAzure();
    console.log(`Found ${pdfs.length} PDFs in Azure`);
    res.json({ pdfs });
  } catch (err) {
    console.error("Error fetching PDFs from Azure:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch PDFs from Azure", details: err.message });
  }
});

// === Filter PDFs by fields (gets from Azure then filters) ===
router.get("/filter-pdfs-azure", async (req, res) => {
  const {
    filename,
    description,
    status,
    bolt_hole_size,
    bolt_pattern,
    bolt_circle_diameter,
    bolt_hole_style,
    from_date,
    to_date,
  } = req.query;

  try {
    console.log("Fetching and filtering PDFs from Azure...");
    let pdfs = await getAllPdfsFromAzure();
    console.log(`Retrieved ${pdfs.length} PDFs from Azure for filtering`);

    // Only filter by fields that are present in the query
    if (filename)
      pdfs = pdfs.filter(
        (m) =>
          m.filename &&
          m.filename.toLowerCase().includes(filename.toLowerCase())
      );
    if (description)
      pdfs = pdfs.filter(
        (m) =>
          m.description &&
          m.description.toLowerCase().includes(description.toLowerCase())
      );
    if (status)
      pdfs = pdfs.filter(
        (m) => m.status && m.status.toLowerCase() === status.toLowerCase()
      );
    if (bolt_hole_size)
      pdfs = pdfs.filter(
        (m) =>
          m.bolt_hole_size &&
          m.bolt_hole_size.toLowerCase().includes(bolt_hole_size.toLowerCase())
      );
    if (bolt_pattern)
      pdfs = pdfs.filter(
        (m) =>
          m.bolt_pattern &&
          m.bolt_pattern.toLowerCase().includes(bolt_pattern.toLowerCase())
      );
    if (bolt_circle_diameter)
      pdfs = pdfs.filter(
        (m) =>
          m.bolt_circle_diameter &&
          m.bolt_circle_diameter
            .toLowerCase()
            .includes(bolt_circle_diameter.toLowerCase())
      );
    if (bolt_hole_style)
      pdfs = pdfs.filter(
        (m) =>
          m.bolt_hole_style &&
          m.bolt_hole_style
            .toLowerCase()
            .includes(bolt_hole_style.toLowerCase())
      );
    if (from_date)
      pdfs = pdfs.filter(
        (m) => m.uploadedAt && new Date(m.uploadedAt) >= new Date(from_date)
      );
    if (to_date)
      pdfs = pdfs.filter(
        (m) => m.uploadedAt && new Date(m.uploadedAt) <= new Date(to_date)
      );

    console.log(`Filtered to ${pdfs.length} PDFs`);
    res.json({ pdfs });
  } catch (err) {
    console.error("Error filtering PDFs from Azure:", err);
    res.status(500).json({
      error: "Failed to filter PDFs from Azure",
      details: err.message,
    });
  }
});

// --- Edit/Replace an existing PDF in Azure Blob Storage ===
router.post("/edit-pdf-azure", azureUpload.single("pdf"), async (req, res) => {
  const {
    email,
    blobUrl,
    description,
    status,
    bolt_hole_size,
    bolt_pattern,
    bolt_circle_diameter,
    bolt_hole_style,
    ...otherInfo
  } = req.body;
  if (!email || !blobUrl) {
    return res
      .status(400)
      .json({ error: "User email and blobUrl are required" });
  }

  try {
    console.log("Editing PDF in Azure:", { email, blobUrl });

    // Extract blob name from blobUrl
    const url = new URL(blobUrl);
    const blobName = decodeURIComponent(
      url.pathname.replace(`/${AZURE_BLOB_CONTAINER}/`, "")
    );

    // If a new file is uploaded, overwrite the existing blob with metadata
    if (req.file) {
      const metadata = {
        description,
        status,
        bolt_hole_size,
        bolt_pattern,
        bolt_circle_diameter,
        bolt_hole_style,
        ...otherInfo,
      };
      await uploadPdfToAzureWithSAS(email, req.file, metadata, blobName);
    } else {
      // Just update metadata without replacing the file
      const metadata = {
        email,
        description,
        status,
        bolt_hole_size,
        bolt_pattern,
        bolt_circle_diameter,
        bolt_hole_style,
        uploadedAt: new Date().toISOString(),
        ...otherInfo,
      };
      await updatePdfMetadataInAzure(blobUrl, metadata);
    }

    console.log("PDF updated in Azure successfully");
    res.json({ message: "PDF updated in Azure successfully", blobUrl });
  } catch (err) {
    console.error("Azure Blob edit error", err.message, err);
    res
      .status(500)
      .json({ error: "Failed to update PDF in Azure", details: err.message });
  }
});

/*
This error means your Azure SAS token is expired or not valid for the current time.

How to fix permanently:
1. Go to Azure Portal > Storage Account > Containers > Shared access signature.
2. Generate a new SAS token:
   - Set the start time to a few minutes in the past (to avoid clock skew).
   - Set the expiry time far in the future (as needed).
   - Make sure to allow all required permissions (read, write, create, delete, list).
3. Copy the new SAS token string (everything after the `?`).
4. Update your `.env` file:
   AZURE_SAS_TOKEN=sv=... (paste the new SAS token here)
5. Restart your Node.js server.

Why does this happen?
- The SAS token is only valid between its start and expiry time.
- If the current time is outside this window, Azure will return a 403 AuthenticationFailed error.
- Uploads/updates to Azure Blob Storage require a valid SAS token.

Summary:
- Generate a new SAS token with a valid time window.
- Update your `.env` file.
- Restart your backend server.
- The error will be resolved.
*/

// === Delete PDF from Azure Blob Storage ===
router.delete("/delete-pdf-azure", async (req, res) => {
  console.log("DELETE /delete-pdf-azure endpoint hit", req.body);
  const { email, blobUrl } = req.body;

  if (!email || !blobUrl) {
    console.log("Delete request missing required fields:", {
      email: !!email,
      blobUrl: !!blobUrl,
    });
    return res
      .status(400)
      .json({ error: "User email and blobUrl are required" });
  }

  try {
    console.log("Starting delete process for:", { email, blobUrl });

    // Extract blob name from blobUrl
    const url = new URL(blobUrl);
    const blobName = decodeURIComponent(
      url.pathname.replace(`/${AZURE_BLOB_CONTAINER}/`, "")
    );
    console.log("Extracted blob name:", blobName);

    // Delete from Azure Blob Storage
    console.log("Attempting to delete from Azure Blob Storage...");
    const blobServiceClient = getBlobServiceClientWithSAS();
    const containerClient =
      blobServiceClient.getContainerClient(AZURE_BLOB_CONTAINER);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Check if blob exists before deleting
    const exists = await blockBlobClient.exists();
    console.log("Blob exists in Azure:", exists);

    if (exists) {
      await blockBlobClient.delete();
      console.log("Successfully deleted blob from Azure");
    } else {
      console.log("Blob not found in Azure, continuing with metadata cleanup");
    }

    console.log("PDF deleted from Azure successfully");

    res.json({
      message: "PDF deleted successfully",
      deletedFromAzure: exists,
    });
  } catch (err) {
    console.error("Azure Blob delete error (detailed):", {
      message: err.message,
      stack: err.stack,
      name: err.name,
    });
    res.status(500).json({
      error: "Failed to delete PDF from Azure",
      details: err.message,
      type: err.name || "UnknownError",
    });
  }
});

module.exports = router;
