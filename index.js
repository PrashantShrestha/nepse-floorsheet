// index.js — NEPSE Floor Sheet Scraper (stable + loop fix)
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

  // Visit floor sheet page
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

  // Try selecting 500 rows
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
  let previousFirstContract = null;
  let repetitionCount = 0;

  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    try {
      await page.waitForSelector("table.table-striped tbody tr", { timeout: 40000 });

      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll("table.table-striped tbody tr"))
          .map(tr =>
            Array.from(tr.querySelectorAll("td")).map(td =>
              td.textContent.trim().replace(/"/g, '""').replace(/\.00$/, "")
            )
          )
          .filter(row => row.length > 0)
      );

      if (rows.length === 0) {
        console.log("⛔ No rows found. Likely end of data.");
        break;
      }

      const currentFirstContract = rows[0][1];
      if (currentFirstContract === previousFirstContract) {
        repetitionCount++;
        console.warn(`⚠️ Repeated ContractNo (${currentFirstContract}) on page ${currentPage}. (${repetitionCount}x)`);
      } else {
        repetitionCount = 0;
      }
      previousFirstContract = currentFirstContract;

      if (repetitionCount >= 2) {
        console.log("🛑 Page repetition detected. Ending scraping.");
        break;
      }

      rows.forEach(cols => logger.write(`"${cols.join('","')}"\n`));
      console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);

      const nextButton = await page.$("li.pagination-next > a");
      if (!nextButton) {
        console.log("⛔ 'Next' button not found. Reached last page.");
        break;
      }

      await nextButton.click();
      await page.waitForFunction(() => {
        const rows = document.querySelectorAll("table.table-striped tbody tr");
        return rows.length > 0;
      }, { timeout: 45000 });

      await new Promise(res => setTimeout(res, Math.random() * 3000 + 2000));
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
