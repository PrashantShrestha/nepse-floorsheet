// index.js — NEPSE Floor Sheet Scraper (stable, safe, and CI-friendly)

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const randomUseragent = require("random-useragent");

puppeteer.use(StealthPlugin());

(async () => {
  const isGitHub = !!process.env.GITHUB_ACTIONS;

  const browser = await puppeteer.launch({
    headless: isGitHub ? true : "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setUserAgent(randomUseragent.getRandom());

  // Block unnecessary resources for faster loading
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "stylesheet", "font", "media"].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Prepare file name with current date
  const dateStamp = new Date().toISOString().split("T")[0];
  const csvFile = `floor_sheet_data_${dateStamp}.csv`;
  const logger = fs.createWriteStream(csvFile, { flags: "a" });

  // Write CSV header if the file is new or empty
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
      { timeout: 40000 }
    );
  } catch (e) {
    console.error("❌ Failed to load floor sheet:", e.message);
    await page.screenshot({ path: "error_screenshot.png" });
    fs.writeFileSync("error_dump.html", await page.content());
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
        { timeout: 30000 }
      ),
    ]);
  } catch (e) {
    console.warn("⚠️ Could not select 500 rows:", e.message);
  }

  let currentPage = 1;
  let seenContracts = new Set();
  let repeatedPages = 0;

  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    try {
      await page.waitForSelector("table.table-striped tbody tr", { timeout: 20000 });

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
        console.log("⛔ No rows found. Possibly end of data.");
        break;
      }

      // Repeated ContractNo detection
      const firstContractNo = rows[0][1]; // ContractNo is 2nd column
      if (seenContracts.has(firstContractNo)) {
        repeatedPages++;
        console.warn(`⚠️ Repeated ContractNo (${firstContractNo}) detected. Count: ${repeatedPages}`);
        if (repeatedPages >= 2) {
          console.log("🛑 Same page data repeated. Ending scraping to avoid infinite loop.");
          break;
        }
      } else {
        seenContracts.add(firstContractNo);
        repeatedPages = 0;
      }

      rows.forEach((cols) => {
        logger.write(`"${cols.join('","')}"\n`);
      });

      console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);

      // 🛑 Check if next page button exists
      const nextBtn = await page.$("li.pagination-next > a");
      if (!nextBtn) {
        console.log("⛔ No 'Next' button found. Reached last page.");
        break;
      }

      // Proceed to next page
      await Promise.all([
        nextBtn.click(),
        page.waitForFunction(
          () => document.querySelectorAll("table.table-striped tbody tr").length > 0,
          { timeout: 30000 }
        ),
      ]);

      // Random delay to avoid detection
      const delay = Math.floor(Math.random() * 3000) + 2000;
      await new Promise((r) => setTimeout(r, delay));

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
