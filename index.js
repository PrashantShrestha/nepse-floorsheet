// index.js — Stable NEPSE Floor Sheet Scraper 2026

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const randomUseragent = require("random-useragent");

puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setUserAgent(randomUseragent.getRandom());

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    // Allowed stylesheets to ensure proper UI rendering and reliable button clicks
    if (["image", "font", "media"].includes(type)) {
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

  console.log("🔄 Navigating to NEPSE floor sheet...");
  try {
    await page.goto("https://nepalstock.com.np/floor-sheet", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    await page.waitForFunction(
      () => document.querySelector("app-root")?.innerText.trim().length > 1000,
      { timeout: 50000 }
    );
  } catch (e) {
    console.error("❌ Failed to load NEPSE site:", e.message);
    await browser.close();
    process.exit(1);
  }

  // Reliable dropdown selection with retries
  try {
    await page.waitForSelector("div.box__filter--field select", { timeout: 20000 });
    for (let i = 0; i < 3; i++) {
      await page.select("div.box__filter--field select", "500");
      const btn = await page.waitForSelector("button.box__filter--search", { timeout: 20000 });
      
      await btn.click();
      
      // Separated the wait logic to avoid unhandled promise rejections on quick loads
      try {
        await page.waitForFunction(
          () => document.querySelectorAll("table.table-striped tbody tr").length >= 100,
          { timeout: 20000 }
        );
      } catch (err) {
        // Let it attempt verification below even if the function timed out
      }

      const rowCount = await page.$$eval("table.table-striped tbody tr", trs => trs.length);
      if (rowCount >= 100) {
        console.log("✅ Successfully set view to 500 rows.");
        break;
      }
      console.warn("⚠️ Retry selecting 500 rows, attempt:", i + 1);
      await new Promise(res => setTimeout(res, 3000));
    }
  } catch (e) {
    console.warn("⚠️ Could not reliably select 500 rows:", e.message);
  }

  let currentPage = 1;
  const seenContracts = new Set();
  let repeatedPages = 0;

  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);
    try {
      await page.waitForSelector("table.table-striped tbody tr", { timeout: 40000 });

      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll("table.table-striped tbody tr"))
          .map((tr) =>
            Array.from(tr.querySelectorAll("td")).map((td) =>
              td.textContent.trim().replace(/"/g, '""').replace(/\.00$/, "")
            )
          )
          .filter((row) => row.length > 0)
      );

      if (rows.length === 0) {
        console.log("⛔ No rows found. Likely end of data.");
        break;
      }

      // 1. CAPTURE AN ANCHOR VALUE BEFORE LEAVING THE PAGE
      const previousFirstContract = rows[0][1];

      const contractNos = rows.map((r) => r[1]);
      const contractSet = new Set(contractNos);
      const overlapCount = [...contractSet].filter(no => seenContracts.has(no)).length;

      if (contractSet.size > 0 && overlapCount === contractSet.size) {
        repeatedPages++;
        console.warn(`⚠️ Full repeat detected on page ${currentPage}. Repeated ${repeatedPages} time(s)`);
        if (repeatedPages >= 2) {
          console.log("🛑 Ending due to repeated identical pages.");
          break;
        }
      } else {
        repeatedPages = 0;
      }

      contractSet.forEach(no => seenContracts.add(no));
      rows.forEach(cols => logger.write(`"${cols.join('","')}"\n`));

      console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);

      if (rows.length < 500) {
        console.log("🛑 Less than 500 rows. Likely last page.");
        break;
      }

      const nextButton = await page.$("li.pagination-next > a");
      const isDisabled = await page.$eval("li.pagination-next", el => el.classList.contains("disabled")).catch(() => false);

      if (!nextButton || isDisabled) {
        console.log("⛔ 'Next' button not available or disabled. Reached last page.");
        break;
      }

      // 2. CLICK NEXT
      await nextButton.click();

      // 3. EXPLICITLY WAIT FOR DOM CONTENT TO CHANGE
      console.log("⏳ Waiting for data layer to update...");
      await page.waitForFunction(
        (oldContract) => {
          const firstRowCell = document.querySelector("table.table-striped tbody tr td:nth-child(2)");
          return firstRowCell && firstRowCell.textContent.trim() !== oldContract;
        },
        { timeout: 35000 },
        previousFirstContract
      ).catch(() => console.warn("⚠️ Automation state warning: Data update took too long. Proceeding..."));

      // Short variable anti-bot delay after content is confirmed loaded
      const postLoadDelay = Math.floor(Math.random() * 2000) + 1000;
      await new Promise(res => setTimeout(res, postLoadDelay));

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
