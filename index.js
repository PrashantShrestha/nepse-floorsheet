// Import required modules
const puppeteer = require("puppeteer-extra"); // Enhanced puppeteer with plugins
const StealthPlugin = require("puppeteer-extra-plugin-stealth"); // Avoid bot detection
const fs = require("fs"); // File system module for writing to CSV
const randomUseragent = require("random-useragent"); // Generates random user-agent strings

// Use stealth plugin to bypass bot detection
puppeteer.use(StealthPlugin());

(async () => {
  // Launch a Chromium browser instance
  const browser = await puppeteer.launch({
    headless: true, // Set to true to hide browser UI
    defaultViewport: null, // Use full screen size
    args: ["--no-sandbox", "--disable-setuid-sandbox"], // Necessary for some systems (e.g., Linux)
  });

  // Open a new page in the browser
  const page = await browser.newPage();

  // Create a filename based on the current date
  const dateStamp = new Date().toISOString().split("T")[0];
  const csvFile = `floor_sheet_data_${dateStamp}.csv`;

  // Open a write stream to the CSV file in append mode
  const logger = fs.createWriteStream(csvFile, { flags: "a" });

  // If the file is new or empty, write CSV headers
  if (!fs.existsSync(csvFile) || fs.statSync(csvFile).size === 0) {
    logger.write("SN,ContractNo,Symbol,Buyer,Seller,Quantity,Rate,Amount\n");
  }

  // Set a random user-agent string to mimic a real browser
  await page.setUserAgent(randomUseragent.getRandom());

  // Intercept requests and block unnecessary resources for faster loading
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "stylesheet", "font", "media"].includes(type)) {
      req.abort(); // Block heavy resources
    } else {
      req.continue(); // Allow all other requests
    }
  });

  console.log("🔄 Starting floor sheet scraping...");

  // Navigate to NEPSE floor sheet page
  await page.goto("https://nepalstock.com.np/floor-sheet", {
    waitUntil: "networkidle2", // Wait until network is idle
  });

  // Try selecting 500 rows per page to minimize pagination
  try {
    await page.waitForSelector("div.box__filter--field select", {
      timeout: 20000,
    });

    // Select "500" from the dropdown (rows per page)
    await page.select("div.box__filter--field select", "500");

    // Click on the "Search" button to apply filter
    const btn = await page.waitForSelector("button.box__filter--search", {
      timeout: 20000,
    });

    await Promise.all([
      btn.click(), // Click search
      page.waitForResponse((res) => res.ok(), { timeout: 30000 }), // Wait for network response
    ]);

    // Ensure the table is loaded before proceeding
    await page.waitForSelector("table.table-striped tbody tr", {
      timeout: 20000,
    });
  } catch (e) {
    // If anything fails in setup, log error and exit
    console.warn(`❌ Failed to set initial filter: ${e.message}`);
    await browser.close();
    return;
  }

  let currentPage = 1; // Start from page 1

  // Loop until "Next" is disabled
  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    // Wait for table rows to be available
    await page.waitForSelector("table.table-striped tbody tr", {
      timeout: 20000,
    });

    // Extract data from table rows
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
                  .replace(/"/g, '""') // Escape double quotes for CSV
                  .replace(/\.00$/, "")}"` // Remove trailing .00
            )
            .join(",")
        )
        .filter((row) => row.length > 0); // Exclude empty rows
    });

    // Append rows to CSV
    rows.forEach((row) => logger.write(`${row}\n`));
    console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);

    // Check if the "Next" button is disabled
    const isNextDisabled = await page.evaluate(() => {
      const nextLi = document.querySelector("li.pagination-next");
      return nextLi?.classList.contains("disabled");
    });

    // If no more pages, break loop
    if (isNextDisabled) {
      console.log("⛔ No more pages. Scraping complete.");
      break;
    }

    // Try to go to next page
    try {
      const nextSelector = "li.pagination-next > a";

      await Promise.all([
        page.click(nextSelector), // Click on "Next"
        page.waitForFunction(
          () => {
            const table = document.querySelector("table.table-striped tbody");
            return table && table.children.length > 0; // Wait for table to load
          },
          { timeout: 60000 } // Wait up to 60 seconds
        ),
      ]);

      // Introduce random delay (2–10 seconds) to mimic human behavior
      const delay = Math.floor(Math.random() * 8000) + 2000;
      await page.waitForTimeout(delay);

      currentPage++; // Move to next page
    } catch (e) {
      // Handle errors in pagination
      console.warn(`⚠️ Failed to go to next page: ${e.message}`);
      break;
    }
  }

  // Close CSV stream and browser
  logger.close();
  await browser.close();
  console.log("🎉 Done scraping all available pages.");
})();
