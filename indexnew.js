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

  console.log("🔄 Starting floor sheet scraping...");

  await page.goto("https://nepalstock.com.np/floor-sheet", {
    waitUntil: "networkidle2",
  });

  try {
    await page.waitForSelector("div.box__filter--field select", { timeout: 20000 });
    await page.select("div.box__filter--field select", "500");

    const btn = await page.waitForSelector("button.box__filter--search", { timeout: 20000 });

    await Promise.all([
      btn.click(),
      page.waitForFunction(
        () =>
          document.querySelectorAll("table.table-striped tbody tr").length >= 500,
        { timeout: 30000 }
      ),
    ]);

    await page.waitForSelector("table.table-striped tbody tr", { timeout: 20000 });
  } catch (e) {
    console.warn(`❌ Failed to set initial filter: ${e.message}`);
    await browser.close();
    return;
  }

  let currentPage = 1;

  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    await page.waitForSelector("table.table-striped tbody tr", { timeout: 20000 });

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

    // Log and check Next button's class
    const nextButtonClass = await page.evaluate(() => {
      const nextLi = document.querySelector("li.pagination-next");
      return nextLi ? nextLi.className : "not-found";
    });
    console.log(`🔍 Next button class: ${nextButtonClass}`);

    if (nextButtonClass === "not-found" || nextButtonClass.includes("disabled")) {
      console.log("⛔ Reached last page or couldn't find 'Next' button. Stopping.");
      break;
    }

    try {
      const nextSelector = "li.pagination-next > a";

      // Wait briefly to avoid DOM race conditions
      await page.waitForTimeout(1000);

      await Promise.all([
        page.click(nextSelector),
        page.waitForFunction(
          () =>
            document.querySelector("table.table-striped tbody")?.children
              ?.length > 0,
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
  console.log("🎉 Done scraping all available pages.");
})();
