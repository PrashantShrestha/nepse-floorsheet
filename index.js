// Import required modules
const puppeteer = require("puppeteer-extra"); // Enhanced Puppeteer with plugin support
const StealthPlugin = require("puppeteer-extra-plugin-stealth"); // Hides automation indicators
const fs = require("fs"); // For file writing
const randomUseragent = require("random-useragent"); // To mimic a real browser

// Enable stealth plugin to avoid bot detection
puppeteer.use(StealthPlugin());

(async () => {
  // Launch browser with stability flags for headless CI environments (like GitHub Actions)
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ],
  });

  const page = await browser.newPage();

  // Set a consistent viewport size to avoid layout issues
  await page.setViewport({ width: 1280, height: 1200 });

  // Create a CSV file with today's date
  const dateStamp = new Date().toISOString().split("T")[0];
  const csvFile = `floor_sheet_data_${dateStamp}.csv`;
  const logger = fs.createWriteStream(csvFile, { flags: "a" });

  // Write CSV headers if the file is new or empty
  if (!fs.existsSync(csvFile) || fs.statSync(csvFile).size === 0) {
    logger.write("SN,ContractNo,Symbol,Buyer,Seller,Quantity,Rate,Amount\n");
  }

  // Set a random user-agent to mimic real browser traffic
  await page.setUserAgent(randomUseragent.getRandom());

  // Block loading of images, fonts, media, and stylesheets to improve scraping speed
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "stylesheet", "font", "media"].includes(type)) {
      req.abort(); // Skip unnecessary resources
    } else {
      req.continue(); // Allow everything else
    }
  });

  console.log("🔄 Navigating to NEPSE floor sheet...");
  await page.goto("https://nepalstock.com.np/floor-sheet", {
    waitUntil: "networkidle2", // Wait until the page is fully loaded
  });

  // Attempt to select 500 rows per page and initialize the table
  try {
    await page.waitForSelector("div.box__filter--field select", {
      timeout: 20000,
    });

    // Select "500" rows per page
    await page.select("div.box__filter--field select", "500");

    // Click on the "Search" button to apply the filter
    const btn = await page.waitForSelector("button.box__filter--search", {
      timeout: 20000,
    });

    // Wait until at least 500 rows are loaded in the table
    await Promise.all([
      btn.click(),
      page.waitForFunction(
        () =>
          document.querySelectorAll("table.table-striped tbody tr").length >= 500,
        { timeout: 30000 }
      ),
    ]);
  } catch (e) {
    console.warn(`❌ Failed to initialize table: ${e.message}`);
    await browser.close();
    return;
  }

  let currentPage = 1;

  // Loop through pages until the "Next" button is disabled
  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    // Wait until rows are available in the table
    await page.waitForSelector("table.table-striped tbody tr", {
      timeout: 20000,
    });

    // Scrape and format each row of the table
    const rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("table.table-striped tbody tr"))
        .map((tr) =>
          Array.from(tr.querySelectorAll("td"))
            .map((td) =>
              `"${td.textContent.trim().replace(/"/g, '""').replace(/\.00$/, "")}"`
            )
            .join(",")
        )
        .filter((row) => row.length > 0); // Remove empty rows
    });

    // Write the rows to the CSV file
    rows.forEach((row) => logger.write(`${row}\n`));
    console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);

    // Wait for the pagination element to load
    await page.waitForSelector("li.pagination-next", { timeout: 10000 });
    await page.waitForTimeout(1000); // Give Angular time to finish rendering

    // Check if "Next" button is disabled (i.e., no <a> inside the pagination item)
    const isNextDisabled = await page.evaluate(() => {
      const next = document.querySelector("li.pagination-next");
      const nextAnchor = next?.querySelector("a");
      return !nextAnchor; // If there's no <a>, we're at the last page
    });

    if (isNextDisabled) {
      console.log("⛔ 'Next' button is disabled or missing. Scraping complete.");
      break; // Exit the loop
    }

    // Go to the next page
    try {
      const nextSelector = "li.pagination-next > a";

      await Promise.all([
        page.click(nextSelector),
        page.waitForFunction(() => {
          const table = document.querySelector("table.table-striped tbody");
          return table && table.children.length > 0;
        }, { timeout: 60000 }),
      ]);

      // Wait 2–10 seconds randomly to mimic human browsing
      const delay = Math.floor(Math.random() * 8000) + 2000;
      await page.waitForTimeout(delay);
      currentPage++;
    } catch (e) {
      console.warn(`⚠️ Failed to go to next page: ${e.message}`);
      break;
    }
  }

  // Clean up resources
  logger.close();
  await browser.close();
  console.log("🎉 Scraping finished successfully.");
})();
