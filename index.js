const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const randomUseragent = require("random-useragent");
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Use puppeteer stealth plugin to reduce bot detection
puppeteer.use(StealthPlugin());

/**
 * Check if data already exists in Firestore for a given document ID.
 * This helps skip re-uploading the same row and supports resuming.
 */
async function checkIfDataExists(entryId) {
  const dateKey = new Date().toISOString().split("T")[0]; // e.g., 2025-05-08
  const entryDoc = await db.collection("floorsheet_by_date")
    .doc(dateKey)
    .collection("entries")
    .doc(entryId)
    .get();

  return entryDoc.exists;
}

(async () => {
  // --- CONFIGURATION ---
  //const START_PAGE = 13; // 👈 Set the page number you want to resume from
  const START_PAGE = parseInt(process.argv[2], 10) || 1;
  let currentPage = START_PAGE;
  let entryCounter = (START_PAGE - 1) * 500 + 1; // Estimate starting ID based on page
  const dateStamp = new Date().toISOString().split("T")[0];

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setUserAgent(randomUseragent.getRandom());

  // Block unnecessary resources (images, fonts, etc.)
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "stylesheet", "font", "media"].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  console.log("🔄 Launching browser and navigating to NEPSE floor sheet...");

  // Load the floor sheet page
  await page.goto("https://nepalstock.com.np/floor-sheet", {
    waitUntil: "networkidle2",
  });

  try {
    // Set rows per page to 500 (maximum)
    await page.waitForSelector("div.box__filter--field select", { timeout: 20000 });
    await page.select("div.box__filter--field select", "500");

    // Apply filter
    const btn = await page.waitForSelector("button.box__filter--search", { timeout: 20000 });
    await Promise.all([
      btn.click(),
      page.waitForResponse((res) => res.ok(), { timeout: 30000 }),
    ]);

    await page.waitForSelector("table.table-striped tbody tr", { timeout: 20000 });
  } catch (e) {
    console.warn(`❌ Failed to set initial filter: ${e.message}`);
    await browser.close();
    return;
  }

  // Move to the desired page number if resuming
  if (START_PAGE > 1) {
    console.log(`⏩ Navigating to page ${START_PAGE}...`);
    for (let i = 1; i < START_PAGE; i++) {
      const isNextDisabled = await page.evaluate(() => {
        const nextLi = document.querySelector("li.pagination-next");
        return nextLi?.classList.contains("disabled");
      });

      if (isNextDisabled) {
        console.warn(`⛔ Cannot go to page ${START_PAGE}. End reached at page ${i}.`);
        await browser.close();
        return;
      }

      await Promise.all([
        page.click("li.pagination-next > a"),
        page.waitForFunction(() => {
          const table = document.querySelector("table.table-striped tbody");
          return table && table.children.length > 0;
        }, { timeout: 60000 }),
      ]);

      const delay = Math.floor(Math.random() * 3000) + 1000;
      await page.waitForTimeout(delay);
    }
  }

  const entriesCollection = db
    .collection("floorsheet_by_date")
    .doc(dateStamp)
    .collection("entries");

  // 🔁 Main scraping loop
  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    await page.waitForSelector("table.table-striped tbody tr", { timeout: 20000 });

    // Extract table rows from the page
    const rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("table.table-striped tbody tr"))
        .map((tr) =>
          Array.from(tr.querySelectorAll("td"))
            .map((td) =>
              `"${td.textContent.trim().replace(/"/g, '""').replace(/\.00$/, "")}`
            ).join(",")
        ).filter((row) => row.length > 0);
    });

    // ⏳ Process each row
    for (const row of rows) {
      const fields = row.split(",");
      const paddedId = entryCounter.toString().padStart(7, "0");

      // Check if row already exists
      const exists = await checkIfDataExists(paddedId);
      if (exists) {
        process.stdout.write(`\r⚠️ Skipping existing row with ID: ${paddedId}`);
        entryCounter++;
        continue;
      }

      // Sanitize and convert rate
      const rate = parseFloat(fields[6].replace(/,/g, "").trim());

      try {
        // Upload to Firestore
        await entriesCollection.doc(paddedId).set({
          ContractNo: fields[1].replace(/"/g, ""),
          Symbol: fields[2].replace(/"/g, ""),
          Buyer: fields[3].replace(/"/g, ""),
          Seller: fields[4].replace(/"/g, ""),
          Quantity: parseInt(fields[5].replace(/"/g, "")),
          Rate: rate,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
        process.stdout.write(`\r✅ Last uploaded ID: ${paddedId}`);
        entryCounter++;
      } catch (e) {
        console.warn(`⚠️ Failed to upload row: ${e.message}`);
      }
    }

    console.log(`\n✅ Page ${currentPage}: Processed ${rows.length} rows`);

    // ⏹️ Check if next page exists
    const isNextDisabled = await page.evaluate(() => {
      const nextLi = document.querySelector("li.pagination-next");
      return nextLi?.classList.contains("disabled");
    });

    if (isNextDisabled) {
      console.log("⛔ No more pages. Scraping complete.");
      break;
    }

    try {
      // Go to next page
      await Promise.all([
        page.click("li.pagination-next > a"),
        page.waitForFunction(() => {
          const table = document.querySelector("table.table-striped tbody");
          return table && table.children.length > 0;
        }, { timeout: 60000 }),
      ]);

      const delay = Math.floor(Math.random() * 4000) + 1000;
      await page.waitForTimeout(delay);
      currentPage++;
    } catch (e) {
      console.warn(`⚠️ Failed to go to next page: ${e.message}`);
      break;
    }
  }

  await browser.close();
  console.log("🎉 Finished scraping all available pages.");
})();
