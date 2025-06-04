// index.js — NEPSE Floor Sheet Scraper (fixed)

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

  try {
    console.log("🔄 Navigating to floor sheet page...");
    await page.goto("https://nepalstock.com.np/floor-sheet", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Wait until Angular has fully rendered
    await page.waitForFunction(
      () => document.querySelector("app-root")?.innerText.length > 1000,
      { timeout: 30000 }
    );

    // Wait for dropdown to be present
    await page.waitForSelector("div.box__filter--field select", {
      timeout: 20000,
    });

    // Select 500 rows from dropdown
    await page.select("div.box__filter--field select", "500");

    // Wait for the Search button and click
    const searchBtn = await page.waitForSelector("button.box__filter--search", {
      timeout: 20000,
    });

    await Promise.all([
      searchBtn.click(),
      page.waitForFunction(() => {
        const rows = document.querySelectorAll("table.table-striped tbody tr");
        return rows.length >= 500;
      }, { timeout: 30000 })
    ]);

  } catch (e) {
    console.error("❌ Initial page setup failed:", e.message);
    await page.screenshot({ path: "error_screenshot.png" });
    fs.writeFileSync("error_dump.html", await page.content());
    await browser.close();
    process.exit(1);
  }

  // Begin scraping pages
  let currentPage = 1;

  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    try {
      await page.waitForSelector("table.table-striped tbody tr", {
        timeout: 20000,
      });

      const rows = await page.evaluate(() => {
        return Array.from(
          document.querySelectorAll("table.table-striped tbody tr")
        ).map(tr =>
          Array.from(tr.querySelectorAll("td"))
            .map(td =>
              `"${td.textContent.trim().replace(/"/g, '""').replace(/\.00$/, "")}"`
            ).join(",")
        ).filter(row => row.length > 0);
      });

      console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);
      rows.forEach(row => logger.write(`${row}\n`));

      const isNextDisabled = await page.evaluate(() => {
        const nextBtn = document.querySelector("li.pagination-next");
        return nextBtn?.classList.contains("disabled");
      });

      if (isNextDisabled) {
        console.log("⛔ No more pages. Scraping complete.");
        break;
      }

      // Go to next page and wait for it to load
      await Promise.all([
        page.click("li.pagination-next > a"),
        page.waitForFunction(() => {
          const rows = document.querySelectorAll("table.table-striped tbody tr");
          return rows.length > 0;
        }, { timeout: 30000 }),
      ]);

      // Delay to simulate human
      const delay = Math.floor(Math.random() * 3000) + 2000;
      await new Promise(r => setTimeout(r, delay));

      currentPage++;
    } catch (e) {
      console.warn(`⚠️ Error on page ${currentPage}: ${e.message}`);
      break;
    }
  }

  logger.close();
  await browser.close();
  console.log("🎉 Finished scraping all available pages.");
})();
