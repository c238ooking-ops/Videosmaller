import fs from "fs";
import https from "https";
import { execSync } from "child_process";

const API_BASE = "https://www.udrop.com/api/v2";

let ACCOUNTS = [];
try {
  ACCOUNTS = JSON.parse(process.env.UDROP_ACCOUNTS_JSON || "[]");
} catch (e) {
  console.error("❌ Failed to parse UDROP_ACCOUNTS_JSON secret.");
  process.exit(1);
}

if (ACCOUNTS.length === 0) {
  console.error("❌ No accounts configured in UDROP_ACCOUNTS_JSON.");
  process.exit(1);
}

const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 180000
});

function getMediaDuration(filePath) {
  try {
    const stdout = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    const parsed = parseFloat(stdout.toString().trim());
    return isNaN(parsed) ? 0 : parsed;
  } catch (err) {
    console.warn(`   ⚠️ Warning: Could not probe duration for ${filePath}: ${err.message}`);
    return 0;
  }
}

async function authorize(key1, key2) {
  const res = await fetch(`${API_BASE}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key1, key2 })
  });
  const data = await res.json();
  if (data._status !== "success") {
    throw new Error(`Auth failed: ${data.response || JSON.stringify(data)}`);
  }
  return { token: data.data.access_token, accountId: data.data.account_id };
}

async function getFreeSpace(token, accountId) {
  try {
    const res = await fetch(`${API_BASE}/account/package`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: token, account_id: accountId })
    });
    const data = await res.json();

    if (data._status === "success" && data.data) {
      const total = Number(data.data.total_storage_bytes || data.data.max_storage_bytes || 0);
      const used = Number(data.data.storage_used_bytes || data.data.total_storage_used || 0);
      if (total === 0) return 500 * 1024 * 1024 * 1024;
      return Math.max(0, total - used);
    }
  } catch (err) {
    console.warn(`Storage check warning: ${err.message}`);
  }
  return 100 * 1024 * 1024 * 1024;
}

// --- FIXED: Uses String() instead of Python's str() ---
async function getOrCreateFolder(token, accountId, folderName, parentId = null) {
  try {
    const listParams = new URLSearchParams({ access_token: token, account_id: accountId });
    if (parentId) listParams.append("parent_folder_id", parentId);
    
    const listRes = await fetch(`${API_BASE}/folder/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: listParams
    });
    const listData = await listRes.json();
    
    if (listData._status === "success" && listData.data) {
      const foldersList = listData.data.folders || listData.data;
      if (Array.isArray(foldersList)) {
        const existing = foldersList.find(f => 
          f.status !== "trash" && String(f.folderName || "").trim().toLowerCase() === folderName.trim().toLowerCase()
        );
        if (existing) return String(existing.id);
      }
    }

    // Create folder with public visibility ("is_public": "1")
    const createParams = new URLSearchParams({
      access_token: token,
      account_id: accountId,
      folder_name: folderName,
      is_public: "1"
    });
    if (parentId) createParams.append("parent_id", parentId);

    const createRes = await fetch(`${API_BASE}/folder/create`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createParams
    });
    const createData = await createRes.json();
    
    if (createData._status === "success" && createData.data) {
      return String(createData.data.id || createData.data.folder_id);
    }
  } catch (err) {
    console.warn(`   ⚠️ Warning: Folder resolution encountered an error: ${err.message}`);
  }
  return parentId;
}

function uploadStream(filePath, fileName, token, accountId, folderId) {
  return new Promise((resolve, reject) => {
    const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
    const stats = fs.statSync(filePath);
    const totalSize = stats.size;
    const isMpegTs = fileName.endsWith(".ts") || fileName.endsWith(".mkv");
    const mimeType = isMpegTs ? "video/mp2t" : "application/octet-stream";

    let headParts = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="access_token"`,
      "",
      token,
      `--${boundary}`,
      `Content-Disposition: form-data; name="account_id"`,
      "",
      accountId
    ];

    if (folderId) {
      headParts.push(
        `--${boundary}`,
        `Content-Disposition: form-data; name="folder_id"`,
        "",
        folderId
      );
    }

    headParts.push(
      `--${boundary}`,
      `Content-Disposition: form-data; name="upload_file"; filename="${fileName}"`,
      `Content-Type: ${mimeType}`,
      "",
      ""
    );

    const head = headParts.join("\r\n");
    const tail = `\r\n--${boundary}--\r\n`;
    const contentLength = Buffer.byteLength(head) + totalSize + Buffer.byteLength(tail);

    const req = https.request("https://www.udrop.com/api/v2/file/upload", {
      method: "POST",
      agent: httpsAgent,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": contentLength,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      }
    }, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data._status === "success") {
            resolve(data);
          } else {
            reject(new Error(data.response || JSON.stringify(data)));
          }
        } catch (e) {
          reject(new Error(`Invalid server response: ${body.substring(0, 300)}`));
        }
      });
    });

    req.on("error", reject);
    req.write(head);

    const fileStream = fs.createReadStream(filePath, { highWaterMark: 128 * 1024 });
    let uploadedBytes = 0;
    let lastReport = 0;

    fileStream.on("data", (chunk) => {
      uploadedBytes += chunk.length;
      fileStream.pause();

      const canContinue = req.write(chunk);

      const now = Date.now();
      if (now - lastReport > 3000) {
        const pct = ((uploadedBytes / totalSize) * 100).toFixed(1);
        const mb = (uploadedBytes / (1024 * 1024)).toFixed(0);
        const totalMb = (totalSize / (1024 * 1024)).toFixed(0);
        console.log(`   ⏳ Transferred: ${mb}MB / ${totalMb}MB (${pct}%)`);
        lastReport = now;
      }

      if (!canContinue) {
        req.once("drain", () => setTimeout(() => fileStream.resume(), 10));
      } else {
        setTimeout(() => fileStream.resume(), 10);
      }
    });

    fileStream.on("end", () => {
      req.write(tail);
      req.end();
    });

    fileStream.on("error", (err) => {
      req.destroy();
      reject(err);
    });
  });
}

async function run() {
  const baseName = process.env.BASE_NAME || "Video";
  const targetFolderId = process.env.TARGET_FOLDER_ID || "";

  const files = fs.readdirSync(".")
    .filter(f => f.startsWith("part-") && (f.endsWith(".ts") || f.endsWith(".mkv")))
    .sort();

  if (files.length === 0) {
    console.error("❌ No split parts found in root directory.");
    process.exit(1);
  }

  const ext = files[0].endsWith(".ts") ? ".ts" : ".mkv";

  const pool = [];
  for (const acc of ACCOUNTS) {
    try {
      console.log(`🔑 Authenticating & checking storage: [${acc.name}]...`);
      const auth = await authorize(acc.key1, acc.key2);
      const freeBytes = await getFreeSpace(auth.token, auth.accountId);
      console.log(`   Available space: ${(freeBytes / (1024 ** 3)).toFixed(2)} GB`);
      pool.push({ ...acc, ...auth, freeBytes, activeFolderId: null });
    } catch (e) {
      console.warn(`   ⚠️ Skipped ${acc.name}: ${e.message}`);
    }
  }

  if (pool.length === 0) {
    console.error("❌ No valid authenticated accounts available.");
    process.exit(1);
  }

  const isMultiPart = files.length > 1;
  let partIndex = 1;
  const uploadedRecords = [];

  for (const file of files) {
    const stats = fs.statSync(file);
    const fileSize = stats.size;
    const targetName = isMultiPart 
      ? `${baseName}.Part${partIndex}${ext}` 
      : `${baseName}${ext}`;

    console.log(`\n📦 Probing & preparing: ${targetName} (${(fileSize / (1024 ** 3)).toFixed(2)} GB)`);

    const duration = getMediaDuration(file);
    console.log(`   ⏱️ Segment duration: ${duration.toFixed(2)} seconds`);

    const targetAcc = pool.find(acc => acc.freeBytes > (fileSize + 200 * 1024 * 1024));
    if (!targetAcc) {
      console.error(`❌ Out of storage! No account has enough space for ${targetName}`);
      process.exit(1);
    }

    if (!targetAcc.activeFolderId) {
      console.log(`   📁 Ensuring public folder "${baseName}" exists in [${targetAcc.name}]...`);
      targetAcc.activeFolderId = await getOrCreateFolder(targetAcc.token, targetAcc.accountId, baseName, targetFolderId);
    }

    console.log(`🚀 Uploading to [${targetAcc.name}]...`);

    let uploadResult = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        uploadResult = await uploadStream(file, targetName, targetAcc.token, targetAcc.accountId, targetAcc.activeFolderId);
        console.log(`✅ Upload complete for ${targetName}!`);
        break;
      } catch (err) {
        console.warn(`   ⚠️ Attempt ${attempt} failed (${err.message}). Retrying in 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (!uploadResult) {
      console.error(`❌ Failed to upload ${targetName} after 3 attempts.`);
      process.exit(1);
    }

    const fileMeta = Array.isArray(uploadResult.data) ? uploadResult.data[0] : uploadResult.data;
    const shortUrl = fileMeta?.short_url || fileMeta?.shortUrl;
    const fileUrl = shortUrl ? `https://www.udrop.com/file/${shortUrl}/${encodeURIComponent(targetName)}` : (fileMeta?.url || "");
    console.log(`   🔗 Direct Landing URL: ${fileUrl}`);

    uploadedRecords.push({
      name: "uDrop",
      title: baseName,
      url: fileUrl,
      filename: targetName,
      duration: parseFloat(duration.toFixed(3)),
      size: fileSize
    });

    targetAcc.freeBytes -= fileSize;
    partIndex++;
  }

  fs.writeFileSync("uploaded_records.json", JSON.stringify(uploadedRecords, null, 2));

  let db = {};
  if (fs.existsSync("database.json")) {
    try {
      db = JSON.parse(fs.readFileSync("database.json", "utf-8"));
    } catch (e) {
      console.log("⚠️ Could not parse existing database.json, starting fresh merge.");
    }
  }

  const entryKey = `custom_${baseName.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  
  db[entryKey] = {
    meta: {
      name: baseName,
      poster: "",
      type: "movie"
    },
    streams: uploadedRecords.map(r => ({
      name: r.name,
      title: `${baseName} [Standard]`,
      url: r.url,
      filename: r.filename,
      duration: r.duration,
      size: r.size
    }))
  };

  fs.writeFileSync("database.json", JSON.stringify(db, null, 2));
  console.log("\n🎉 Updated local database.json with exact part durations!");

  const syncWorkerUrl = process.env.SYNC_WORKER_URL;
  const syncSecret = process.env.SYNC_SECRET;

  if (syncWorkerUrl && syncSecret) {
    console.log("🔄 Syncing complete database to Cloudflare Worker KV...");
    try {
      const res = await fetch(syncWorkerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-sync-secret": syncSecret
        },
        body: JSON.stringify(db)
      });
      const resultText = await res.text();
      console.log(`✅ Cloudflare Sync Response: ${resultText}`);
    } catch (err) {
      console.warn(`⚠️ Warning: Failed to sync to Cloudflare Worker: ${err.message}`);
    }
  } else {
    console.log("ℹ️ Skipping auto-sync (SYNC_WORKER_URL or SYNC_SECRET not set).");
  }
}

run();
