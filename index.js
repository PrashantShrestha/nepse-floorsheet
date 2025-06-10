// index.js — NEPSE Floor Sheet Scraper with loop detection and last-page fix

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const randomUseragent = require("random-useragent");

// Use puppeteer stealth to evade bot detection
puppeteer.use(StealthPlugin());

(async () => {
  // Launch headless browser with recommended flags for GitHub Actions
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Set a random user-agent to mimic real browsers
  await page.setUserAgent(randomUseragent.getRandom());

  // Block unnecessary resources for speed
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "stylesheet", "font", "media"].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Prepare CSV filename with today's date
  const dateStamp = new Date().toISOString().split("T")[0];
  const csvFile = `floor_sheet_data_${dateStamp}.csv`;
  const logger = fs.createWriteStream(csvFile, { flags: "a" });

  // Write CSV header if file is new or empty
  if (!fs.existsSync(csvFile) || fs.statSync(csvFile).size === 0) {
    logger.write("SN,ContractNo,Symbol,Buyer,Seller,Quantity,Rate,Amount\n");
  }

  // Go to NEPSE floor sheet page
  console.log("🔄 Navigating to floor sheet page...");
  try {
    await page.goto("https://nepalstock.com.np/floor-sheet", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Wait until page content is sufficiently loaded
    await page.waitForFunction(
      () => document.querySelector("app-root")?.innerText.trim().length > 1000,
      { timeout: 55000 }
    );
  } catch (e) {
    console.error("❌ Failed to load floor sheet:", e.message);
    await page.screenshot({ path: "error_screenshot.png" });
    fs.writeFileSync("error_dump.html", await page.content());
    await browser.close();
    process.exit(1);
  }

  // Try selecting 500 rows per page if available
  try {
    await page.waitForSelector("div.box__filter--field select", { timeout: 20000 });
    await page.select("div.box__filter--field select", "500");

    const btn = await page.waitForSelector("button.box__filter--search", { timeout: 20000 });

    await Promise.all([
      btn.click(),
      page.waitForFunction(
        () => document.querySelectorAll("table.table-striped tbody tr").length >= 100,
        { timeout: 40000 }
      ),
    ]);
  } catch (e) {
    console.warn("⚠️ Could not select 500 rows:", e.message);
  }

  // Initialize page number and loop detection variables
  let currentPage = 1;
  let seenContracts = new Set(); // Set of seen ContractNos (2nd column)
  let repeatedPages = 0;         // Count of how many times the same ContractNo was seen

  // Start scraping pages in a loop
  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    try {
      // Wait for the table to load
      await page.waitForSelector("table.table-striped tbody tr", { timeout: 40000 });

      // Extract rows as arrays of cell values (no quotes yet)
      const rows = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("table.table-striped tbody tr"))
          .map((tr) =>
            Array.from(tr.querySelectorAll("td")).map((td) =>
              td.textContent.trim().replace(/"/g, '""').replace(/\.00$/, "")
            )
          )
          .filter((row) => row.length > 0);
      });

      // If table is empty, assume we're done
      if (rows.length === 0) {
        console.log("⛔ No rows found. Likely end of data.");
        break;
      }

      // Get ContractNo (2nd column) from first row to detect repetition
      const firstContractNo = rows[0][1];
      if (seenContracts.has(firstContractNo)) {
        repeatedPages++;
        console.warn(`⚠️ Repeated ContractNo (${firstContractNo}) detected. Repeated ${repeatedPages} time(s).`);
        // Stop if same ContractNo seen more than once (prevents infinite loop)
        if (repeatedPages >= 2) {
          console.log("🛑 Detected page repetition. Ending scraping.");
          break;
        }
      } else {
        seenContracts.add(firstContractNo);
        repeatedPages = 0; // reset repetition tracker
      }

      // Write rows to CSV file
      rows.forEach((cols) => {
        logger.write(`"${cols.join('","')}"\n`);
      });

      console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);

      // Click "Next" and wait for table to reload
      await Promise.all([
        page.click("li.pagination-next > a"),
        page.waitForFunction(
          () => document.querySelectorAll("table.table-striped tbody tr").length > 0,
          { timeout: 30000 }
        ),
      ]);

      // Delay next page scrape to mimic human behavior
      const delay = Math.floor(Math.random() * 4500) + 2000;
      await new Promise((r) => setTimeout(r, delay));

      currentPage++;
    } catch (e) {
      // ✅ Suppress "No element found for selector" error as expected end of data
      if (e.message.includes("No element found for selector: li.pagination-next > a")) {
        console.log("⛔ 'Next' button not found. Reached last page.");
        break;
      }

      // Other unexpected errors
      console.warn(`⚠️ Error during scraping page ${currentPage}: ${e.message}`);
      break;
    }
  }

  // Clean up
  logger.close();
  await browser.close();
  console.log("🎉 Finished scraping all available pages.");
})();
