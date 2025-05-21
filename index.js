// Import required modules
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const randomUseragent = require("random-useragent");

// Use stealth plugin to bypass bot detection
puppeteer.use(StealthPlugin());

(async () => {
  // Launch headless browser
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Generate filename based on date
  const dateStamp = new Date().toISOString().split("T")[0];
  const csvFile = `floor_sheet_data_${dateStamp}.csv`;

  // Open write stream for CSV
  const logger = fs.createWriteStream(csvFile, { flags: "a" });

  // Write header if new file
  if (!fs.existsSync(csvFile) || fs.statSync(csvFile).size === 0) {
    logger.write("SN,ContractNo,Symbol,Buyer,Seller,Quantity,Rate,Amount\n");
  }

  // Set random user-agent
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

  console.log("🔄 Starting floor sheet scraping...");

  // Go to NEPSE floor sheet page
  await page.goto("https://nepalstock.com.np/floor-sheet", {
    waitUntil: "networkidle2",
  });

  try {
    // Wait for dropdown and select "500" rows per page
    await page.waitForSelector("div.box__filter--field select", {
      timeout: 20000,
    });
    await page.select("div.box__filter--field select", "500");

    // Click the search button and wait for at least 500 rows to load
    const btn = await page.waitForSelector("button.box__filter--search", {
      timeout: 20000,
    });

    await Promise.all([
      btn.click(),
      page.waitForFunction(
        () =>
          document.querySelectorAll("table.table-striped tbody tr").length >=
          500,
        { timeout: 30000 }
      ),
    ]);
  } catch (e) {
    console.warn(`❌ Failed to set initial filter: ${e.message}`);
    await browser.close();
    return;
  }
  // change currentPages = 175 to 1 before final
  let currentPage = 175;

  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    // Wait for table rows
    await page.waitForSelector("table.table-striped tbody tr", {
      timeout: 20000,
    });

    // Extract table data
    const rows = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll("table.table-striped tbody tr")
      )
        .map((tr) =>
          Array.from(tr.querySelectorAll("td"))
            .map(
              (td) =>
                `"${td.textContent
                  .trim()
                  .replace(/"/g, '""')
                  .replace(/\.00$/, "")}"`
            )
            .join(",")
        )
        .filter((row) => row.length > 0);
    });

    // Write to CSV
    rows.forEach((row) => logger.write(`${row}\n`));
    console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);

   // Wait for pagination control
    await page.waitForSelector("li.pagination-next", { timeout: 10000 });

  // Check if the <a> tag exists inside the next button
  const isNextDisabled = await page.evaluate(() => {
    const nextLi = document.querySelector("li.pagination-next");
    const nextAnchor = nextLi?.querySelector("a");
    return !nextAnchor;
  });
    
    // Exit loop if no more pages
    if (isNextDisabled) {
      console.log("⛔ 'Next' button is disabled. Scraping complete.");
      break;
    }

    // Go to next page
    try {
      const nextSelector = "li.pagination-next > a";

      await Promise.all([
        page.click(nextSelector),
        page.waitForFunction(
          () => {
            const table = document.querySelector("table.table-striped tbody");
            return table && table.children.length > 0;
          },
          { timeout: 60000 }
        ),
      ]);

      // Random delay (2–10 sec) to mimic human behavior
      const delay = Math.floor(Math.random() * 8000) + 2000;
      await page.waitForTimeout(delay);

      currentPage++;
    } catch (e) {
      console.warn(`⚠️ Failed to go to next page: ${e.message}`);
      break;
    }
  }

  // Cleanup
  logger.close();
  await browser.close();
  console.log("🎉 Done scraping all available pages.");
})();
