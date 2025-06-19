// index.js — NEPSE Floor Sheet Scraper (Stable for GitHub Actions)

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const randomUseragent = require("random-useragent");

// Enable stealth mode
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setUserAgent(randomUseragent.getRandom());

  // Block unnecessary resources
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "stylesheet", "font", "media"].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  const dateStamp = new Date().toISOString().split("T")[0];
  const csvFile = `floor_sheet_data_${dateStamp}.csv`;
  const logger = fs.createWriteStream(csvFile, { flags: "a" });

  if (!fs.existsSync(csvFile) || fs.statSync(csvFile).size === 0) {
    logger.write("SN,ContractNo,Symbol,Buyer,Seller,Quantity,Rate,Amount\n");
  }

  console.log("🔄 Navigating to floor sheet page...");
  try {
    await page.goto("https://nepalstock.com.np/floor-sheet", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    await page.waitForFunction(
      () => document.querySelector("app-root")?.innerText.trim().length > 1000,
      { timeout: 55000 }
    );
  } catch (e) {
    console.error("❌ Failed to load floor sheet:", e.message);
    await browser.close();
    process.exit(1);
  }

  // Try selecting 500 rows per page
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

  let currentPage = 1;
  const seenContracts = new Set();

  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    try {
      await page.waitForSelector("table.table-striped tbody tr", { timeout: 40000 });

      // Scrape rows
      const rows = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("table.table-striped tbody tr"))
          .map((tr) =>
            Array.from(tr.querySelectorAll("td")).map((td) =>
              td.textContent.trim().replace(/"/g, '""').replace(/\.00$/, "")
            )
          )
          .filter((row) => row.length > 0);
      });

      if (rows.length === 0) {
        console.log("⛔ No rows found. Likely end of data.");
        break;
      }

      // Extract contract numbers from current page
      const contractNos = rows.map((row) => row[1]);
      const contractSet = new Set(contractNos);
      const previousSeenCount = [...contractSet].filter((c) => seenContracts.has(c)).length;

      if (previousSeenCount === contractSet.size) {
        console.warn(`⚠️ All ${contractSet.size} ContractNos already seen. Ending scraping.`);
        break;
      }

      contractSet.forEach((c) => seenContracts.add(c));
      rows.forEach((cols) => logger.write(`"${cols.join('","')}"\n`));

      console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);

      // If fewer than 500 rows, it’s the last page
      if (rows.length < 500) {
        console.log("🛑 Less than 500 rows. Likely last page.");
        break;
      }

      const currentFirstContract = rows[0][1];

      // Click next and wait until new contract number appears
      const nextButton = await page.$("li.pagination-next > a");
      if (!nextButton) {
        console.log("⛔ 'Next' button not found. Reached last page.");
        break;
      }

      await nextButton.click();
      await page.waitForFunction(
        (prevFirst) => {
          const newFirst = document.querySelector("table.table-striped tbody tr td:nth-child(2)");
          return newFirst && newFirst.textContent.trim() !== prevFirst;
        },
        { timeout: 60000 },
        currentFirstContract
      );

      // Random delay
      const delay = Math.floor(Math.random() * 4000) + 2000;
      await new Promise((res) => setTimeout(res, delay));
      currentPage++;
    } catch (e) {
      console.warn(`⚠️ Error during scraping page ${currentPage}: ${e.message}`);
      break;
    }
  }

  logger.close();
  await browser.close();
  console.log("🎉 Finished scraping all available pages.");
})();
