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
    await page.waitForSelector("div.box__filter--field select", {
      timeout: 20000,
    });

    await page.select("div.box__filter--field select", "500");

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

    rows.forEach((row) => logger.write(`${row}\n`));
    console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);

    // OPTIONAL DEBUGGING: Save screenshot of footer (pagination)
    await page.screenshot({
      path: `page${currentPage}_footer.png`,
      clip: { x: 0, y: 900, width: 1200, height: 300 },
    });

    await page.waitForSelector("li.pagination-next", { timeout: 10000 });

    // ✅ Robust way to check if "Next" is disabled
    const isNextDisabled = await page.evaluate(() => {
      const next = document.querySelector("li.pagination-next");
      const nextAnchor = next?.querySelector("a");
      return !nextAnchor;
    });

    if (isNextDisabled) {
      console.log("⛔ 'Next' button is disabled or missing. Scraping done.");
      break;
    }

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

      const delay = Math.floor(Math.random() * 8000) + 2000;
      await page.waitForTimeout(delay);
      currentPage++;
    } catch (e) {
      console.warn(`⚠️ Failed to go to next page: ${e.message}`);
      break;
    }
  }

  logger.close();
  await browser.close();
  console.log("🎉 Scraping completed successfully.");
})();
