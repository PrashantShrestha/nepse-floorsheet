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

  // Block images, fonts, and other unused resources
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
    await page.screenshot({ path: "error_screenshot.png" });
    fs.writeFileSync("error_dump.html", await page.content());
    await browser.close();
    process.exit(1);
  }

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
  let repeatedPages = 0;
  let lastPageFirstContract = null;

  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    try {
      await page.waitForSelector("table.table-striped tbody tr", { timeout: 40000 });

      const rows = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("table.table-striped tbody tr"))
          .map(tr =>
            Array.from(tr.querySelectorAll("td")).map(td =>
              td.textContent.trim().replace(/"/g, '""').replace(/\.00$/, "")
            )
          )
          .filter(row => row.length > 0);
      });

      if (rows.length === 0) {
        console.log("⛔ No rows found. Likely end of data.");
        break;
      }

      // Extract ContractNos for this page
      const contractNos = rows.map(row => row[1]);
      const contractSet = new Set(contractNos);

      // Check for high overlap (90%+) with already seen contracts
      const overlap = [...contractSet].filter(no => seenContracts.has(no)).length;

      if (currentPage > 3 && overlap / contractSet.size > 0.9) {
        repeatedPages++;
        console.warn(`⚠️ ${overlap}/${contractSet.size} ContractNos already seen. Repetition count: ${repeatedPages}`);
        if (repeatedPages >= 2) {
          console.log("🛑 Likely stuck in loop. Ending scraping.");
          break;
        }
      } else {
        repeatedPages = 0;
      }

      // Add all contracts to global set
      contractSet.forEach(no => seenContracts.add(no));

      // Write rows to CSV
      rows.forEach(cols => {
        logger.write(`"${cols.join('","')}"\n`);
      });

      console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);

      const firstContract = contractNos[0];

      // Try click next page
      const nextButton = await page.$("li.pagination-next > a");
      if (!nextButton) {
        console.log("⛔ 'Next' button not found. Reached last page.");
        break;
      }

      await Promise.all([
        nextButton.click(),
        page.waitForFunction(
          (prev) => {
            const firstRow = document.querySelector("table.table-striped tbody tr");
            const newContract = firstRow?.children?.[1]?.textContent?.trim();
            return newContract && newContract !== prev;
          },
          { timeout: 45000 },
          firstContract
        ),
      ]);

      const delay = Math.floor(Math.random() * 4500) + 2000;
      await new Promise(res => setTimeout(res, delay));

      currentPage++;
    } catch (e) {
      if (e.message.includes("No element found for selector: li.pagination-next > a")) {
        console.log("⛔ 'Next' button not found. Reached last page.");
        break;
      }
      console.warn(`⚠️ Error during scraping page ${currentPage}: ${e.message}`);
      break;
    }
  }

  logger.close();
  await browser.close();
  console.log("🎉 Finished scraping all available pages.");
})();
