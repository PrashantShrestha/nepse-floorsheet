// index.js — NEPSE Floor Sheet Scraper (page 1 fix)

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

  console.log("🔄 Navigating to floor sheet page...");
  try {
    await page.goto("https://nepalstock.com.np/floor-sheet", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    await page.waitForFunction(
      () => document.querySelector("app-root")?.innerText.trim().length > 1000,
      { timeout: 30000 }
    );
  } catch (e) {
    console.error("❌ Failed to load floor sheet:", e.message);
    await page.screenshot({ path: "error_screenshot.png" });
    fs.writeFileSync("error_dump.html", await page.content());
    await browser.close();
    process.exit(1);
  }

  // Select 500 rows if possible
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
        () => {
          const rows = document.querySelectorAll("table.table-striped tbody tr");
          return rows.length >= 100; // wait for >100 rows to ensure "500" has rendered
        },
        { timeout: 30000 }
      ),
    ]);
  } catch (e) {
    console.warn("⚠️ Could not select 500 rows:", e.message);
  }

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
        )
          .map((tr) =>
            Array.from(tr.querySelectorAll("td"))
              .map((td) =>
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

      const isNextDisabled = await page.evaluate(() => {
        const nextLi = document.querySelector("li.pagination-next");
        return nextLi?.classList.contains("disabled");
      });

      if (isNextDisabled) {
        console.log("⛔ No more pages. Scraping complete.");
        break;
      }

      await Promise.all([
        page.click("li.pagination-next > a"),
        page.waitForFunction(
          () =>
            document.querySelectorAll("table.table-striped tbody tr").length > 0,
          { timeout: 30000 }
        ),
      ]);

      const delay = Math.floor(Math.random() * 3000) + 2000;
      await new Promise((r) => setTimeout(r, delay));

      currentPage++;
    } catch (e) {
      console.warn(`⚠️ Error during pagination: ${e.message}`);
      break;
    }
  }

  logger.close();
  await browser.close();
  console.log("🎉 Finished scraping all available pages.");
})();
