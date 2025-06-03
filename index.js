const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const randomUseragent = require("random-useragent");

puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1200 });

  const dateStamp = new Date().toISOString().split("T")[0];
  const csvFile = `floor_sheet_data_${dateStamp}.csv`;
  const logger = fs.createWriteStream(csvFile, { flags: "a" });

  if (!fs.existsSync(csvFile) || fs.statSync(csvFile).size === 0) {
    logger.write("SN,ContractNo,Symbol,Buyer,Seller,Quantity,Rate,Amount\n");
  }

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

  console.log("🔄 Navigating to NEPSE floor sheet...");
  await page.goto("https://nepalstock.com.np/floor-sheet", {
    waitUntil: "networkidle2",
  });

  try {
    await page.waitForSelector("div.box__filter--field select", { timeout: 20000 });
    await page.select("div.box__filter--field select", "500");

    const btn = await page.waitForSelector("button.box__filter--search", { timeout: 20000 });

    await Promise.all([
      btn.click(),
      page.waitForResponse(res =>
        res.url().includes("/api/floorsheet") && res.status() === 200,
        { timeout: 30000 }
      ),
    ]);

    await page.waitForTimeout(1000);
  } catch (e) {
    console.warn(`❌ Failed to initialize table: ${e.message}`);
    await browser.close();
    return;
  }

  let currentPage = 1;

  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    await page.waitForSelector("table.table-striped tbody tr", {
      timeout: 20000,
    });

    const rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("table.table-striped tbody tr"))
        .map((tr) =>
          Array.from(tr.querySelectorAll("td"))
            .map((td) =>
              `"${td.textContent.trim().replace(/"/g, '""').replace(/\.00$/, "")}"`
            )
            .join(",")
        )
        .filter((row) => row.length > 0);
    });

    rows.forEach((row) => logger.write(`${row}\n`));
    console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);

    const isNextDisabled = await page.evaluate(() => {
      const next = document.querySelector("li.pagination-next");
      return next?.classList.contains("disabled");
    });

    if (isNextDisabled) {
      console.log("⛔ 'Next' button is disabled. Ending scraping.");
      break;
    }

    try {
      await Promise.all([
        page.click("li.pagination-next > a"),
        page.waitForResponse(res =>
          res.url().includes("/api/floorsheet") && res.status() === 200,
          { timeout: 10000 }
        ),
      ]);
      await page.waitForTimeout(Math.floor(Math.random() * 8000) + 2000);
      currentPage++;
    } catch (e) {
      console.warn(`⚠️ Failed to go to next page: ${e.message}`);
      break;
    }
  }

  logger.close();
  await browser.close();
  console.log("🎉 Scraping finished successfully.");
})();
